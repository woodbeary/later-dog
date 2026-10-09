// later.dog token battery for Codex, end to end: a real disposable server, two ChatGPT accounts on the repository's fake
// Codex app-server, the first one out of usage the way codex-cli 0.154 reports it. Nothing here reaches a real account
// (docs/laterdog/token-battery.md; the Claude half is account-battery.e2e.test.ts).
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../scripts/control-laterdog.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { readUsage } from "./usage-ledger.ts";

const MODEL = "gpt-fake-default";
const FIRST = { instanceId: "codex-one", model: MODEL };
const FAKE_CODEX = fileURLToPath(new URL("./testing/fake-codex-app-server.ts", import.meta.url));
const jsonLines = (path: string): any[] => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

it("continues a Codex conversation on ChatGPT account 2 with the conversation carried over, and comes back after the reset", async () => {
  const fixture = await launchVerificationServer({});
  const { dataDir, url, logPath } = fixture.info;
  const gate = join(dataDir, "codex-account-1-out-of-usage");
  const firstFile = join(dataDir, "codex-account-1-prompts.jsonl");
  const secondFile = join(dataDir, "codex-account-2-prompts.jsonl");
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
    // Two logins: one shared login would share one limit and rest together.
    config.instances["codex-one"] = {
      driver: "codex", displayName: "Codex account 1", config: { cli: FAKE_CODEX },
      environment: { FAKE_CODEX_MODE: "usage-limit", FAKE_CODEX_USAGE_LIMIT_GATE: gate, FAKE_CODEX_USAGE_RESETS_IN: "15",
        FAKE_CODEX_PROMPTS: firstFile, FAKE_CODEX_ACCOUNT_EMAIL: "one@example.test" },
    };
    config.instances["codex-two"] = {
      driver: "codex", displayName: "Codex account 2", config: { cli: FAKE_CODEX },
      environment: { FAKE_CODEX_MODE: "resume", FAKE_CODEX_PROMPTS: secondFile, FAKE_CODEX_REPLY: "hello from codex account 2",
        FAKE_CODEX_ACCOUNT_EMAIL: "two@example.test" },
    };
    config.accountBattery = { enabled: true, order: { codex: ["codex-one", "codex-two"] } };
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
    // Both accounts signed in, so the battery may use either.
    await expect.poll(async () => (await api("GET", "/api/instances")).instances
      .filter((instance: any) => instance.instanceId.startsWith("codex-") && instance.snapshot.state === "available" && instance.snapshot.authenticated !== false)
      .map((instance: any) => instance.instanceId).sort(), { timeout: 30_000, interval: 500 }).toEqual(["codex-one", "codex-two"]);

    const { bot } = await control("new-bot", "--name", "Codex battery");
    const threadId = bot.activeTaskId as string;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: FIRST, updateBotDefault: true });
    const messages = async (): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages;
    const busy = async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id)
      .tasks.find((entry: any) => entry.threadId === threadId).busy;
    const send = (text: string) => control("send", "--bot", bot.id, "--task", threadId, "--text", text);
    const settled = async (done: (rows: any[]) => boolean) => {
      await expect.poll(async () => !(await busy()) && done(await messages()), { timeout: 45_000, interval: 250 }).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await busy()).toBe(false);
    };
    const lastReply = (rows: any[]) => rows.findLast((row) => row.role === "bot" && row.kind === "text");
    const switches = (rows: any[]) => rows.filter((row) => row.tool?.name?.startsWith("recovery: Switched to"));

    // Account 1 has usage: the favourite runs the first turn.
    await send("REMEMBER_CODEX_HISTORY_4K");
    await settled((rows) => lastReply(rows)?.text === "done from fake codex");
    expect(jsonLines(firstFile)).toHaveLength(1);
    expect(jsonLines(secondFile)).toHaveLength(0);

    // Account 1 runs out mid-conversation: the same request runs once on account 2, with the conversation replayed.
    writeFileSync(gate, "out of usage");
    const text = "SWITCH_CODEX_ONCE_5M";
    await send(text);
    await settled((rows) => lastReply(rows)?.text === "hello from codex account 2");
    expect(jsonLines(firstFile)).toHaveLength(2);
    expect(jsonLines(secondFile)).toHaveLength(1);
    const carried = jsonLines(secondFile)[0].text as string;
    expect(carried).toContain("REMEMBER_CODEX_HISTORY_4K");
    expect(carried).toContain("done from fake codex");
    expect(carried.split(text)).toHaveLength(2);
    const rows = await messages();
    evidence.push({ afterSwitch: rows });
    expect(rows.filter((row) => row.role === "user" && row.text === text)).toHaveLength(1);
    expect(rows.some((row) => row.role === "bot" && row.kind === "text" && /hit your usage limit/.test(row.text ?? ""))).toBe(false);
    expect(switches(rows).map((row) => row.tool.name)).toEqual([
      expect.stringMatching(/^recovery: Switched to Codex account 2 — Codex account 1 hit its 5-hour limit, resets (?:[A-Z][a-z]{2} \d{1,2} )?at \d{1,2}:\d\d [AP]M\.$/),
    ]);
    // Rested until the full window's reset, read from the account's rate limits; never saved on the conversation.
    const battery = (await api("GET", "/api/config")).accountBattery;
    // the saved order first; other ChatGPT accounts this server has (the fixture's signed-out default) follow it
    expect(battery.order.codex.slice(0, 2)).toEqual(["codex-one", "codex-two"]);
    const until = Date.parse(battery.resting["codex-one"].until);
    expect(until).toBeGreaterThan(Date.now());
    expect(until).toBeLessThan(Date.now() + 20_000);
    expect(battery.resting["codex-two"]).toBeUndefined();

    // While account 1 rests, the next turn goes straight to account 2.
    await send("STILL_RESTING_CODEX_6P");
    await settled((rows) => rows.at(-1)?.role === "bot" && jsonLines(secondFile).length === 2);
    expect(jsonLines(firstFile)).toHaveLength(2);

    // Its window resets: back on account 1, said once.
    rmSync(gate);
    await expect.poll(async () => Object.keys((await api("GET", "/api/config")).accountBattery.resting), { timeout: 30_000, interval: 500 }).toEqual([]);
    await send("BACK_ON_CODEX_ONE_7Q");
    await settled((rows) => rows.at(-1)?.role === "bot" && jsonLines(firstFile).length === 3);
    const final = await messages();
    evidence.push({ final });
    expect(final.filter((row) => row.tool?.name === "notice: Back on Codex account 1.")).toHaveLength(1);
    expect(switches(final)).toHaveLength(1);
    // each turn is booked to the account that ran it
    await expect.poll(() => readUsage(dataDir, { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) })
      .filter((row) => row.threadId === threadId).map((row) => row.instanceId), { timeout: 10_000 })
      .toEqual(["codex-one", "codex-one", "codex-two", "codex-two", "codex-one"]);
  } finally {
    evidence.push({ firstPrompts: jsonLines(firstFile), secondPrompts: jsonLines(secondFile) });
    writeFileSync(`${logPath}.account-battery-codex.json`, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 180_000);
