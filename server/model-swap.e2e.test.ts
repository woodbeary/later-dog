import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../scripts/control-laterdog.ts";
import { waitForExit } from "./testing/cleanup.ts";

const MODEL = "claude-opus-5-5";
const FALLBACK = "claude-opus-4-8";

it("says in the chat when the engine's safeguards swap the model, once, shows the model that really ran, and never moves the chat to another account", async () => {
  const fixture = await launchVerificationServer({});
  const { dataDir, url, logPath } = fixture.info;
  const flag = join(dataDir, "safeguards-flag");
  const prompts = join(dataDir, "second-account-prompts.jsonl");
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    expect(response.ok, `${method} ${path}`).toBe(true);
    return response.json() as Promise<any>;
  };
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const cli = config.instances.claude.config.cli;
    config.instances.claude = { ...config.instances.claude, displayName: "Claude account 1",
      environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_TOOL_CALLS: "[]", FAKE_CLAUDE_REFUSAL_FALLBACK: FALLBACK, FAKE_CLAUDE_REFUSAL_STATE: flag } };
    config.instances["claude-two"] = { driver: "claudeAgent", displayName: "Claude account 2", config: { cli, configDir: join(dataDir, "providers", "claude-two") },
      environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_TOOL_CALLS: "[]", FAKE_CLAUDE_PROMPTS: prompts } };
    config.accountBattery = { enabled: true, order: { claudeAgent: ["claude", "claude-two"] } };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => { try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; } }, { timeout: 20_000 }).toBe(true);

    const { bot } = await runControlLaterDog(["new-bot", "--name", "Safeguards", "--url", url]) as any;
    const threadId = bot.activeTaskId as string;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: { instanceId: "claude", model: MODEL }, updateBotDefault: true });
    const messages = async (): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages;
    const idle = async () => !(await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).tasks.find((entry: any) => entry.threadId === threadId).busy;
    const send = async (text: string, replies: number) => {
      await runControlLaterDog(["send", "--bot", bot.id, "--task", threadId, "--text", text, "--url", url]);
      await expect.poll(async () => (await idle()) && (await messages()).filter((row) => row.role === "bot" && row.kind === "text").length >= replies, { timeout: 30_000, interval: 250 }).toBe(true);
    };
    const notes = (rows: any[]) => rows.filter((row) => row.tool?.name?.startsWith("notice:")).map((row) => row.tool.name as string);

    await send("FIRST_TURN_FLAGGED_1A", 1);
    expect(existsSync(flag)).toBe(true);
    await send("SECOND_TURN_ON_FALLBACK_2B", 2);
    await send("THIRD_TURN_ON_FALLBACK_3C", 3);
    const rows = await messages();
    expect(notes(rows)).toEqual(["notice: Opus 5.5's safeguards stopped a reply in this chat, so Opus 4.8 is answering for the rest of it."]);
    expect(existsSync(prompts)).toBe(false);
    const battery = (await api("GET", "/api/config")).accountBattery;
    expect(battery.ranModel[threadId]).toBe(FALLBACK);
    expect(battery.routed[threadId]).toBeUndefined();
    const receipts = rows.filter((row) => row.ran).map((row) => row.ran);
    expect(receipts.at(-1)).toMatchObject({ instanceId: "claude", model: MODEL, reportedModel: FALLBACK });
  } finally {
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 120_000);
