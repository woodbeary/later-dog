// later.dog token battery, end to end: a real disposable server, two Claude
// accounts on the repository's fake CLI, the first one out of usage. Nothing
// here reaches a real account (docs/laterdog/token-battery.md).
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../scripts/control-laterdog.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { readUsage } from "./usage-ledger.ts";

const MODEL = "claude-sonnet-5";
const FIRST = { instanceId: "claude", model: MODEL };
const jsonLines = (path: string): any[] => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
/** The words a fake CLI was sent for one turn. */
const promptText = (prompt: any): string => JSON.stringify(prompt?.message?.content ?? prompt);

interface BatteryFixture {
  api: (method: string, path: string, body?: unknown, expectedStatus?: number) => Promise<any>;
  control: (...args: string[]) => Promise<any>;
  /** What account 1 and account 2 were sent, one entry per turn. */
  firstPrompts: () => any[];
  secondPrompts: () => any[];
  /** While this file exists account 1 is out of usage. */
  gate: string;
  /** The account each of a conversation's turns was booked to, in order. */
  bookedTo: (threadId: string) => string[];
  evidence: unknown[];
}

async function withBatteryFixture(
  options: { enabled?: boolean; secondOutOfUsage?: boolean; afterTool?: boolean; resetsIn?: number },
  check: (fixture: BatteryFixture) => Promise<void>,
) {
  const fixture = await launchVerificationServer({});
  const { dataDir, url, logPath } = fixture.info;
  const gate = join(dataDir, "account-1-out-of-usage");
  const firstFile = join(dataDir, "account-1-prompts.jsonl");
  const secondFile = join(dataDir, "account-2-prompts.jsonl");
  const evidence: unknown[] = [{ url, options }];
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, expectedStatus?: number) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    const context = `${method} ${path}: ${JSON.stringify(result)}`;
    if (expectedStatus === undefined) expect(response.ok, context).toBe(true);
    else expect(response.status, context).toBe(expectedStatus);
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
      ...config.instances.claude, displayName: "Claude account 1",
      environment: {
        FAKE_CLAUDE_MODE: "usage-limit", FAKE_CLAUDE_USAGE_LIMIT_GATE: gate, FAKE_CLAUDE_USAGE_RESETS_IN: String(options.resetsIn ?? 3_600),
        FAKE_CLAUDE_PROMPTS: firstFile, FAKE_CLAUDE_TOOL_CALLS: "[]",
        ...(options.afterTool ? { FAKE_CLAUDE_USAGE_LIMIT_AFTER_TOOL: "1" } : {}),
      },
    };
    config.instances["claude-two"] = {
      driver: "claudeAgent", displayName: "Claude account 2",
      config: { cli, configDir: join(dataDir, "providers", "claude-two") },
      environment: {
        FAKE_CLAUDE_MODE: options.secondOutOfUsage ? "usage-limit" : "happy", FAKE_CLAUDE_PROMPTS: secondFile, FAKE_CLAUDE_TOOL_CALLS: "[]",
        FAKE_CLAUDE_REPLIES: JSON.stringify(["hello from account 2"]),
      },
    };
    config.accountBattery = { enabled: options.enabled !== false, order: { claudeAgent: ["claude", "claude-two"] } };
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
    const bookedTo = (threadId: string) => readUsage(dataDir, { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) })
      .filter((row) => row.threadId === threadId).map((row) => row.instanceId);
    await check({ api, control, firstPrompts: () => jsonLines(firstFile), secondPrompts: () => jsonLines(secondFile), gate, bookedTo, evidence });
  } finally {
    evidence.push({ firstPrompts: jsonLines(firstFile), secondPrompts: jsonLines(secondFile) });
    const evidencePath = `${logPath}.account-battery.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}

/** A bot on account 1, and helpers to talk to its conversation. */
async function batteryBot({ api, control }: BatteryFixture, name: string) {
  const { bot } = await control("new-bot", "--name", name);
  const threadId = bot.activeTaskId as string;
  await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: FIRST, updateBotDefault: true });
  const messages = async (): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages;
  const task = async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id)
    .tasks.find((entry: any) => entry.threadId === threadId);
  const send = (text: string) => control("send", "--bot", bot.id, "--task", threadId, "--text", text);
  /** Settled for good: idle, with `done` true of the transcript. A switch
   * starts its second run a moment after the first settles, so a single
   * idle reading can fall between the two. */
  const settled = async (done: (rows: any[]) => boolean) => {
    await expect.poll(async () => !(await task()).busy && done(await messages()), { timeout: 30_000, interval: 250 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await task()).busy).toBe(false);
  };
  return { bot, threadId, messages, task, send, settled };
}

const switches = (rows: any[]) => rows.filter((row) => row.tool?.name?.startsWith("recovery: Switched to"));
const limitRows = (rows: any[]) => rows.filter((row) => row.tool?.ok === false && /hit your session limit/.test(row.tool.name));
const lastReply = (rows: any[]) => rows.findLast((row) => row.role === "bot" && row.kind === "text");
/** What the bot said after the person's `text` (its greeting comes before). */
const repliesAfter = (rows: any[], text: string) =>
  rows.slice(rows.findIndex((row) => row.role === "user" && row.text === text)).filter((row) => row.role === "bot" && row.kind === "text");

it("continues on account 2 with the conversation carried over, switches once, and comes back to account 1 after its reset", async () => {
  await withBatteryFixture({ resetsIn: 15 }, async (fixture) => {
    const { api, control, firstPrompts, secondPrompts, gate, bookedTo, evidence } = fixture;
    const chat = await batteryBot(fixture, "Battery switch");
    // Account 1 has usage: the favourite runs the first turn.
    await chat.send("REMEMBER_BATTERY_HISTORY_7Q");
    await chat.settled((rows) => lastReply(rows)?.text === "hello from fake claude");
    expect(firstPrompts()).toHaveLength(1);
    expect(secondPrompts()).toHaveLength(0);

    // Account 1 runs out mid-conversation.
    writeFileSync(gate, "out of usage");
    const text = "SWITCH_ACCOUNTS_ONCE_8R";
    await chat.send(text);
    await chat.settled((rows) => lastReply(rows)?.text === "hello from account 2");
    expect(firstPrompts()).toHaveLength(2);
    expect(secondPrompts()).toHaveLength(1);
    // the same request, with the conversation so far replayed into account 2
    const carried = promptText(secondPrompts()[0]);
    expect(carried).toContain("REMEMBER_BATTERY_HISTORY_7Q");
    expect(carried).toContain("hello from fake claude");
    expect(carried.split(text)).toHaveLength(2);
    const rows = await chat.messages();
    evidence.push({ afterSwitch: rows });
    expect(rows.filter((row) => row.role === "user" && row.text === text)).toHaveLength(1);
    expect(rows.find((row) => row.role === "user" && row.text === text).requestPending).toBe(false);
    // the limit is never something the bot said, and once the battery has
    // handled it the switch notice takes its row: no error is left to fix
    expect(limitRows(rows)).toHaveLength(0);
    expect(rows.some((row) => row.role === "bot" && row.kind === "text" && /hit your/.test(row.text ?? ""))).toBe(false);
    expect(switches(rows).map((row) => row.tool.name)).toEqual([
      expect.stringMatching(/^recovery: Switched to Claude account 2 — Claude account 1 is out of usage until .*\d:\d\d [AP]M\.$/),
    ]);
    expect(lastReply(rows)).toMatchObject({ text: "hello from account 2", turnSucceeded: true });
    // Never saved: the conversation still names account 1.
    expect((await chat.task()).modelSelection ?? (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === chat.bot.id).modelSelection)
      .toMatchObject(FIRST);
    const resting = (await api("GET", "/api/config")).accountBattery;
    expect(resting.enabled).toBe(true);
    expect(resting.order.claudeAgent).toEqual(["claude", "claude-two"]);
    expect(Date.parse(resting.resting.claude.until)).toBeGreaterThan(Date.now() - 1_000);
    expect(resting.resting["claude-two"]).toBeUndefined();

    // While account 1 rests, the next turn goes straight to account 2.
    await chat.send("STILL_RESTING_3T");
    await chat.settled((rows) => rows.at(-1)?.role === "bot" && secondPrompts().length === 2);
    expect(firstPrompts()).toHaveLength(2);
    expect(secondPrompts()).toHaveLength(2);

    // Its limit resets: back on account 1, said once.
    rmSync(gate);
    await expect.poll(async () => Object.keys((await api("GET", "/api/config")).accountBattery.resting), { timeout: 30_000, interval: 500 }).toEqual([]);
    await chat.send("BACK_ON_FIRST_9S");
    await chat.settled((rows) => rows.at(-1)?.role === "bot" && firstPrompts().length === 3);
    await chat.send("STAYS_ON_FIRST_2V");
    await chat.settled((rows) => rows.at(-1)?.role === "bot" && firstPrompts().length === 4);
    const final = await chat.messages();
    evidence.push({ final });
    expect(secondPrompts()).toHaveLength(2);
    expect(final.filter((row) => row.tool?.name === "notice: Back on Claude account 1.")).toHaveLength(1);
    expect(switches(final)).toHaveLength(1);
    // each turn is booked to the account that ran it, not the one the thread names
    await expect.poll(() => bookedTo(chat.threadId), { timeout: 10_000 })
      .toEqual(["claude", "claude", "claude-two", "claude-two", "claude", "claude"]);
    await control("messages", "--bot", chat.bot.id, "--task", chat.threadId, "--limit", "30");
  });
}, 120_000);

it("tells account 2 to continue, not redo, when a tool already ran on account 1", async () => {
  await withBatteryFixture({ afterTool: true }, async (fixture) => {
    const { firstPrompts, secondPrompts, gate, evidence } = fixture;
    const chat = await batteryBot(fixture, "Battery continuation");
    writeFileSync(gate, "out of usage");
    const text = "CONTINUE_DO_NOT_REDO_4C";
    await chat.send(text);
    await chat.settled((rows) => lastReply(rows)?.text === "hello from account 2");
    expect(firstPrompts()).toHaveLength(1);
    expect(secondPrompts()).toHaveLength(1);
    const sent = promptText(secondPrompts()[0]);
    expect(sent).toContain("Do not redo what was already done.");
    // the request rides the replay once, as the person's last message
    expect(sent.split(text)).toHaveLength(2);
    const rows = await chat.messages();
    evidence.push({ rows });
    expect(rows.filter((row) => row.role === "user")).toHaveLength(1);
    expect(rows.some((row) => row.tool?.name === "Bash")).toBe(true);
    expect(switches(rows)).toHaveLength(1);
    expect(rows.find((row) => row.role === "user" && row.text === text).requestPending).toBe(false);
  });
}, 120_000);

it("tries the next account once: when it is out of usage too, the limit stays the answer", async () => {
  await withBatteryFixture({ secondOutOfUsage: true }, async (fixture) => {
    const { firstPrompts, secondPrompts, gate, evidence, api } = fixture;
    const chat = await batteryBot(fixture, "Battery both out");
    writeFileSync(gate, "out of usage");
    await chat.send("BOTH_OUT_OF_USAGE_5U");
    await chat.settled((rows) => switches(rows).length === 1 && limitRows(rows).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(firstPrompts()).toHaveLength(1);
    expect(secondPrompts()).toHaveLength(1);
    const rows = await chat.messages();
    evidence.push({ rows });
    expect(switches(rows)).toHaveLength(1);
    // the first account's limit became the switch notice; the second's stays
    expect(limitRows(rows)).toHaveLength(1);
    expect(repliesAfter(rows, "BOTH_OUT_OF_USAGE_5U")).toEqual([]);
    // the last row is the failed turn, which is where Retry belongs
    expect(rows.findLast((row) => row.kind !== "digest")?.tool?.ok).toBe(false);
    const battery = (await api("GET", "/api/config")).accountBattery;
    expect(Object.keys(battery.resting).sort()).toEqual(["claude", "claude-two"]);
    // with every account resting, a new message stays on its own account
    await chat.send("ALL_RESTING_6W");
    await chat.settled((rows) => limitRows(rows).length === 2);
    expect(firstPrompts()).toHaveLength(2);
    expect(secondPrompts()).toHaveLength(1);
    expect(switches(await chat.messages())).toHaveLength(1);
  });
}, 120_000);

it("changes nothing while the battery is off, beyond reporting the limit as a failed turn", async () => {
  await withBatteryFixture({ enabled: false }, async (fixture) => {
    const { firstPrompts, secondPrompts, gate, api, evidence } = fixture;
    const chat = await batteryBot(fixture, "Battery off");
    writeFileSync(gate, "out of usage");
    await chat.send("BATTERY_OFF_1A");
    await chat.settled((rows) => limitRows(rows).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(firstPrompts()).toHaveLength(1);
    expect(secondPrompts()).toHaveLength(0);
    const rows = await chat.messages();
    evidence.push({ rows });
    expect(switches(rows)).toHaveLength(0);
    expect(repliesAfter(rows, "BATTERY_OFF_1A")).toEqual([]);
    // the account's rest is still known, for when the battery is switched on
    expect(Object.keys((await api("GET", "/api/config")).accountBattery.resting)).toEqual(["claude"]);
    // switching it on is validated: only the accounts this server has
    const refused = await api("PUT", "/api/config", { accountBattery: { enabled: true, order: { claudeAgent: ["claude", "nobody"] } } }, 400);
    expect(refused.error).toMatch(/nobody/);
    const saved = await api("PUT", "/api/config", { accountBattery: { enabled: true, order: { claudeAgent: ["claude-two", "claude"] } } });
    expect(saved.accountBattery).toMatchObject({ enabled: true, order: { claudeAgent: ["claude-two", "claude"] } });
  });
}, 120_000);
