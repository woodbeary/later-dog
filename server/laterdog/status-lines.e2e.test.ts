import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../../scripts/control-laterdog.ts";
import { waitForExit } from "../testing/cleanup.ts";

const QUICK = { LATERDOG_STATUS_LINE_QUIET_MS: "1500", LATERDOG_STATUS_LINE_EVERY_MS: "1000", LATERDOG_STATUS_LINE_CHECK_MS: "200" };
const LONG_TEST = [{ name: "Bash", input: { command: "pnpm test", description: "Run the focused tests" }, pending: true }];

it.skipIf(process.platform === "win32")("keeps a quiet dog's status in its task for the phone without posting anything into the chat", async () => {
  const fixture = await launchVerificationServer({});
  const { dataDir, url, logPath } = fixture.info;
  const evidence: unknown[] = [{ url }];
  let server: ChildProcess | undefined;
  let transcript: () => Promise<unknown> = async () => null;
  const start = () => {
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), ...QUICK },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
  };
  const healthy = () => expect.poll(async () => {
    try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
  }, { timeout: 20_000 }).toBe(true);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json() as any;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlLaterDog([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const finishGate = join(dataDir, "finish-the-tests");
    config.instances.claude.environment = {
      ...config.instances.claude.environment,
      FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate, FAKE_CLAUDE_TOOL_CALLS: JSON.stringify(LONG_TEST),
    };
    writeFileSync(configPath, JSON.stringify(config));
    start();
    await healthy();

    const { bot } = await control("new-bot", "--name", "Quiet worker");
    const threadId = bot.activeTaskId as string;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, updateBotDefault: true });
    const messages = async (): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages;
    transcript = messages;
    const lines = async () => (await messages()).filter((message) => message.tool?.statusLine);
    const busy = async () => (await api("GET", "/api/bots?messages=0")).bots.find((entry: any) => entry.id === bot.id)?.busy === true;
    const taskLine = async () => (await api("GET", "/api/bots?messages=0")).bots.find((entry: any) => entry.id === bot.id)
      ?.tasks?.find((task: any) => task.threadId === threadId)?.statusLine;

    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Run the tests and tell me when they pass.");
    await expect.poll(taskLine, { timeout: 20_000, interval: 200 }).toBe("Still on it: running the focused tests");
    expect(await busy()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(await lines()).toEqual([]);
    evidence.push({ whileWorking: await taskLine() });

    writeFileSync(finishGate, "done");
    await expect.poll(busy, { timeout: 20_000 }).toBe(false);
    expect(await taskLine()).toBeUndefined();
    expect(await lines()).toEqual([]);
    expect((await messages()).some((message) => message.role === "bot" && message.kind === "text" && message.text.startsWith("reply to:"))).toBe(true);
  } finally {
    evidence.push({ transcript: await transcript().catch((error: unknown) => String(error)) });
    const evidencePath = `${logPath}.status-lines.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 120_000);
