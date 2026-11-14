import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../scripts/control-laterdog.ts";
import { waitForExit } from "./testing/cleanup.ts";

const FABLE = "claude-fable-5-1";
const SONNET = "claude-sonnet-5";
const jsonLines = (path: string): unknown[] => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

it("rests only Fable on daniel when Fable's own weekly limit is reached, and says so in the plan usage report", async () => {
  const fixture = await launchVerificationServer({});
  const { dataDir, url, logPath } = fixture.info;
  const gate = join(dataDir, "fable-limit-reached");
  const danielPrompts = join(dataDir, "daniel-prompts.jsonl");
  const anthonyPrompts = join(dataDir, "anthony-prompts.jsonl");
  const evidence: unknown[] = [{ url }];
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
  const control = async (...args: string[]) => {
    const result = await runControlLaterDog([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const cli = config.instances.claude.config.cli;
    config.instances.claude = {
      ...config.instances.claude, displayName: "daniel",
      config: { ...config.instances.claude.config, configDir: join(dataDir, "providers", "daniel") },
      environment: {
        FAKE_CLAUDE_MODE: "usage-limit", FAKE_CLAUDE_USAGE_LIMIT_GATE: gate, FAKE_CLAUDE_USAGE_LIMIT_MODEL: "fable",
        FAKE_CLAUDE_USAGE_LIMIT_TYPE: "seven_day_overage_included", FAKE_CLAUDE_USAGE_LIMIT: "You've reached your Fable limit.",
        FAKE_CLAUDE_USAGE_RESETS_IN: String(40 * 3600), FAKE_CLAUDE_PROMPTS: danielPrompts, FAKE_CLAUDE_TOOL_CALLS: "[]",
        FAKE_CLAUDE_REPLIES: JSON.stringify(["hello from daniel"]),
      },
    };
    config.instances["claude-anthony"] = {
      driver: "claudeAgent", displayName: "anthony",
      config: { cli, configDir: join(dataDir, "providers", "anthony") },
      environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_PROMPTS: anthonyPrompts, FAKE_CLAUDE_TOOL_CALLS: "[]", FAKE_CLAUDE_REPLIES: JSON.stringify(["hello from anthony"]) },
    };
    config.accountBattery = { enabled: true, order: { claudeAgent: ["claude", "claude-anthony"] } };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);

    const dog = async (name: string, model: string) => {
      const { bot } = await control("new-bot", "--name", name);
      const threadId = bot.activeTaskId as string;
      await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: { instanceId: "claude", model }, updateBotDefault: true });
      const messages = async (): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages;
      const busy = async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).tasks.find((entry: any) => entry.threadId === threadId).busy;
      const reply = async (text: string, answeredOn: string) => {
        const before = jsonLines(answeredOn).length;
        await control("send", "--bot", bot.id, "--task", threadId, "--text", text);
        await expect.poll(async () => !(await busy()) && jsonLines(answeredOn).length === before + 1 && (await messages()).at(-1)?.role === "bot",
          { timeout: 30_000, interval: 250 }).toBe(true);
        return messages();
      };
      return { reply };
    };

    writeFileSync(gate, "Fable's own weekly allowance is used up");
    const fable = await dog("Fable dog", FABLE);
    const fableRows = await fable.reply("FABLE_TURN_1", anthonyPrompts);
    evidence.push({ fableRows });
    expect(fableRows.findLast((row) => row.role === "bot" && row.kind === "text")?.text).toBe("hello from anthony");
    expect.soft(fableRows.filter((row) => row.tool?.name?.startsWith("recovery: Switched to")).map((row) => row.tool.name)).toEqual([
      expect.stringMatching(/^recovery: Switched to anthony — daniel hit its Fable limit, resets /),
    ]);
    expect(jsonLines(danielPrompts)).toHaveLength(1);

    const battery = (await api("GET", "/api/config")).accountBattery;
    evidence.push({ battery });
    expect.soft(battery.resting).not.toHaveProperty("claude");

    const usage = await api("GET", "/api/plan-usage");
    evidence.push({ usage });
    const daniel = usage.providers.find((row: any) => row.id === "claude");
    expect.soft(daniel).not.toHaveProperty("restingUntil");
    expect.soft(daniel.limitsHit).toEqual([{ limit: "model", model: "Fable", label: "Fable weekly limit", until: expect.any(String) }]);
    expect.soft(Date.parse(daniel.limitsHit?.[0]?.until)).toBeGreaterThan(Date.now() + 39 * 3600_000);
    expect.soft(usage.providers.find((row: any) => row.id === "claude-anthony").limitsHit).toEqual([]);
    expect.soft(usage.providers.map((row: any) => row.id)).not.toContain("claudeApi");

    const sonnet = await dog("Sonnet dog", SONNET);
    const sonnetRows = await sonnet.reply("SONNET_TURN_1", danielPrompts);
    expect(sonnetRows.findLast((row) => row.role === "bot" && row.kind === "text")?.text).toBe("hello from daniel");
    expect(sonnetRows.some((row) => row.tool?.name?.startsWith("recovery:"))).toBe(false);
    expect(jsonLines(danielPrompts)).toHaveLength(2);

    await fable.reply("FABLE_TURN_2", anthonyPrompts);
    expect(jsonLines(danielPrompts)).toHaveLength(2);
    expect(jsonLines(anthonyPrompts)).toHaveLength(2);
  } finally {
    const evidencePath = `${logPath}.model-limit.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 120_000);
