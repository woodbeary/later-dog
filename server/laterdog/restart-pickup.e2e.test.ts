import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../../scripts/control-laterdog.ts";
import { waitForExit } from "../testing/cleanup.ts";
import { pickingUpNotice, restartedAgainLine } from "./restart-pickup.ts";

const CLAUDE = { instanceId: "claude", model: "claude-sonnet-5" };

it.skipIf(process.platform === "win32")("picks a message back up after later.dog restarts mid-turn, and says in one line when a second restart cuts it off too", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "laterdog-pickup-"));
  const promptsPath = join(scratch, "prompts.jsonl");
  const firstGate = join(scratch, "finish-first");
  const secondGate = join(scratch, "finish-second");
  const fixture = await launchVerificationServer({});
  const { dataDir, url, logPath } = fixture.info;
  const evidence: unknown[] = [{ url }];
  let server: ChildProcess | undefined;
  let transcript: () => Promise<unknown> = async () => null;
  const configPath = join(dataDir, "config.json");
  const start = (environment: Record<string, string>) => {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.claude.environment = {
      ...config.instances.claude.environment, FAKE_CLAUDE_PROMPTS: promptsPath, FAKE_CLAUDE_REPLIES: JSON.stringify(["I'm checking the login flow now."]), ...environment,
    };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)),
      stdio: ["ignore", log, log],
    });
    closeSync(log);
  };
  const slow = (gate: string) => ({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const healthy = () => expect.poll(async () => {
    try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
  }, { timeout: 30_000 }).toBe(true);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json() as any;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const control = async (...args: string[]) => runControlLaterDog([...args, "--url", url]) as Promise<any>;
  const prompts = (): string[] => existsSync(promptsPath) ? readFileSync(promptsPath, "utf8").trim().split("\n").filter(Boolean) : [];
  const running = () => existsSync(join(dataDir, "turns-running.json")) ? JSON.parse(readFileSync(join(dataDir, "turns-running.json"), "utf8")) : [];
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    start(slow(firstGate));
    await healthy();

    const { bot } = await control("new-bot", "--name", "Scout");
    const threadId = bot.activeTaskId as string;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: CLAUDE, updateBotDefault: true });
    const messages = async (): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages;
    transcript = messages;
    const busy = async () => (await api("GET", "/api/bots?messages=0")).bots.find((entry: any) => entry.id === bot.id)?.busy === true;
    const pickups = async () => (await messages()).filter((message) => message.tool?.pickup === "restart");

    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Fix the login bug.");
    await expect.poll(busy, { timeout: 20_000 }).toBe(true);
    await expect.poll(running, { timeout: 10_000 }).toEqual([expect.objectContaining({ threadId, botId: bot.id })]);
    await waitForExit(server, { signal: "SIGKILL" });

    start(slow(firstGate));
    await healthy();
    await expect.poll(pickups, { timeout: 20_000, interval: 250 }).toEqual([
      expect.objectContaining({ role: "bot", kind: "activity", tool: { name: `recovery: ${pickingUpNotice("Scout")}`, ok: true, pickup: "restart" } }),
    ]);
    await expect.poll(busy, { timeout: 20_000 }).toBe(true);
    await expect.poll(() => prompts().filter((prompt) => prompt.includes("later.dog restarted while you were working")).length, { timeout: 20_000 }).toBe(1);
    expect(prompts().at(-1)).toContain("Fix the login bug.");
    expect((await messages()).filter((message) => message.role === "user").map((message) => message.text)).toEqual(["Fix the login bug."]);
    await waitForExit(server, { signal: "SIGKILL" });
    writeFileSync(firstGate, "done");

    start({ FAKE_CLAUDE_MODE: "happy" });
    await healthy();
    await expect.poll(async () => (await pickups()).map((message) => message.tool.name), { timeout: 20_000, interval: 250 }).toEqual([
      `recovery: ${pickingUpNotice("Scout")}`, `error: ${restartedAgainLine("Scout")}`,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await busy()).toBe(false);
    expect(prompts().filter((prompt) => prompt.includes("later.dog restarted while you were working"))).toHaveLength(1);
    evidence.push({ restartedAgain: await messages() });
    await waitForExit(server, { signal: "SIGTERM" });

    start(slow(secondGate));
    await healthy();
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Now open the pull request.");
    await expect.poll(busy, { timeout: 20_000 }).toBe(true);
    await waitForExit(server, { signal: "SIGKILL" });
    writeFileSync(secondGate, "done");

    start({ FAKE_CLAUDE_MODE: "happy" });
    await healthy();
    await expect.poll(async () => (await pickups()).length, { timeout: 20_000, interval: 250 }).toBe(3);
    await expect.poll(async () => {
      const all = await messages();
      const asked = all.findIndex((message) => message.role === "user" && message.text === "Now open the pull request.");
      return all.slice(asked + 1).some((message) => message.role === "bot" && message.kind === "text" && message.turnTerminal && message.text?.trim());
    }, { timeout: 30_000, interval: 250 }).toBe(true);
    await expect.poll(busy, { timeout: 20_000 }).toBe(false);
    expect(prompts().at(-1)).toContain("Now open the pull request.");
    expect(running()).toEqual([]);
    evidence.push({ pickedUp: await messages(), prompts: prompts().length });
  } finally {
    evidence.push({ transcript: await transcript().catch((error: unknown) => String(error)) });
    const evidencePath = `${logPath}.restart-pickup.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    writeFileSync(firstGate, "done");
    writeFileSync(secondGate, "done");
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 180_000);
