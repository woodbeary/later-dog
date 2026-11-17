import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../../scripts/control-laterdog.ts";
import { waitForExit } from "../testing/cleanup.ts";

const FABLE = "claude-fable-5-1";
const SONNET = "claude-sonnet-5";
const HELD = new Set(["waiting-for-usage", "needs-you"]);
const jsonLines = (path: string): unknown[] => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

it("on one account with only Fable resting, the Fable dog's chat is held and the Sonnet dog's chat is not", async () => {
  const fixture = await launchVerificationServer({});
  const { dataDir, url, logPath } = fixture.info;
  const gate = join(dataDir, "fable-limit-reached");
  const prompts = join(dataDir, "daniel-prompts.jsonl");
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.claude = {
      ...config.instances.claude, displayName: "daniel",
      config: { ...config.instances.claude.config, configDir: join(dataDir, "providers", "daniel") },
      environment: {
        FAKE_CLAUDE_MODE: "usage-limit", FAKE_CLAUDE_USAGE_LIMIT_GATE: gate, FAKE_CLAUDE_USAGE_LIMIT_MODEL: "fable",
        FAKE_CLAUDE_USAGE_LIMIT_TYPE: "seven_day_overage_included", FAKE_CLAUDE_USAGE_LIMIT: "You've reached your Fable limit.",
        FAKE_CLAUDE_USAGE_RESETS_IN: String(40 * 3600), FAKE_CLAUDE_PROMPTS: prompts, FAKE_CLAUDE_TOOL_CALLS: "[]",
        FAKE_CLAUDE_REPLIES: JSON.stringify(["hello from daniel"]),
      },
    };
    config.accountBattery = { enabled: true, order: { claudeAgent: ["claude"] } };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);

    const dog = async (name: string, model: string) => {
      const { bot } = await runControlLaterDog(["new-bot", "--name", name, "--url", url]) as any;
      const threadId = bot.activeTaskId as string;
      await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: { instanceId: "claude", model }, updateBotDefault: true });
      const chat = async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).tasks.find((entry: any) => entry.threadId === threadId);
      const send = async (text: string) => {
        const before = jsonLines(prompts).length;
        await runControlLaterDog(["send", "--bot", bot.id, "--task", threadId, "--text", text, "--url", url]);
        await expect.poll(async () => !(await chat()).busy && jsonLines(prompts).length === before + 1, { timeout: 30_000, interval: 250 }).toBe(true);
      };
      return { chat, send };
    };

    writeFileSync(gate, "Fable's own weekly allowance is used up");
    const fable = await dog("Fable dog", FABLE);
    await fable.send("FABLE_TURN_1");
    await expect.poll(async () => (await fable.chat()).work?.kind, { timeout: 20_000, interval: 250 }).toSatisfy((kind: string) => HELD.has(kind));

    const sonnet = await dog("Sonnet dog", SONNET);
    await sonnet.send("SONNET_TURN_1");
    const sonnetChat = await sonnet.chat();
    expect(sonnetChat.work, JSON.stringify(sonnetChat.work)).toEqual({ kind: "idle" });
    expect(sonnetChat.activity).not.toBe("waiting-on-you");
    expect(HELD.has((await fable.chat()).work?.kind)).toBe(true);
    const rows = (await api("GET", `/api/threads/${sonnetChat.threadId}/messages?limit=50`)).messages as any[];
    expect(rows.findLast((row) => row.role === "bot" && row.kind === "text")?.text).toBe("hello from daniel");
  } finally {
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 120_000);
