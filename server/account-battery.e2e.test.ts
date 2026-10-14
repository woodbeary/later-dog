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
const promptText = (prompt: any): string => JSON.stringify(prompt?.message?.content ?? prompt);

interface BatteryFixture {
  api: (method: string, path: string, body?: unknown, expectedStatus?: number) => Promise<any>;
  control: (...args: string[]) => Promise<any>;
  firstPrompts: () => any[];
  secondPrompts: () => any[];
  gate: string;
  release: string;
  dataDir: string;
  thirdPrompts: () => any[];
  codexCalls: () => Array<{ method: string; params: any }>;
  bookedTo: (threadId: string) => string[];
  evidence: unknown[];
}

async function withBatteryFixture(
  options: { enabled?: boolean; secondOutOfUsage?: boolean; afterTool?: boolean; resetsIn?: number; gated?: boolean; scripted?: boolean; delegateBeforeLimit?: boolean; crossProvider?: boolean; defaultEnabled?: boolean },
  check: (fixture: BatteryFixture) => Promise<void>,
) {
  const fixture = await launchVerificationServer({});
  const { dataDir, url, logPath } = fixture.info;
  const gate = join(dataDir, "account-1-out-of-usage");
  const firstFile = join(dataDir, "account-1-prompts.jsonl");
  const thirdFile = join(dataDir, "account-3-prompts.jsonl");
  const codexDump = join(dataDir, "codex-calls.json");
  const release = join(dataDir, "usage-limit-release");
  const roomPlan = options.scripted ? { FAKE_CLAUDE_ROOM_PLAN: join(dataDir, "room-plan.json") } : {};
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
        ...roomPlan,
        ...(options.delegateBeforeLimit ? { FAKE_CLAUDE_USAGE_LIMIT_ROOM_PLAN: join(dataDir, "room-plan.json") } : {}),
        ...(options.gated ? { FAKE_CLAUDE_USAGE_LIMIT_RELEASE: release } : {}),
        FAKE_CLAUDE_MODE: "usage-limit", FAKE_CLAUDE_USAGE_LIMIT_GATE: gate, FAKE_CLAUDE_USAGE_RESETS_IN: String(options.resetsIn ?? 3_600),
        FAKE_CLAUDE_PROMPTS: firstFile, FAKE_CLAUDE_TOOL_CALLS: "[]",
        ...(options.afterTool ? { FAKE_CLAUDE_USAGE_LIMIT_AFTER_TOOL: "1" } : {}),
      },
    };
    config.instances["claude-two"] = {
      driver: "claudeAgent", displayName: "Claude account 2",
      config: { cli, configDir: join(dataDir, "providers", "claude-two") },
      environment: {
        ...roomPlan,
        FAKE_CLAUDE_MODE: options.secondOutOfUsage ? "usage-limit" : "happy", FAKE_CLAUDE_PROMPTS: secondFile, FAKE_CLAUDE_TOOL_CALLS: "[]",
        FAKE_CLAUDE_REPLIES: JSON.stringify(["hello from account 2"]),
      },
    };
    if (options.scripted) config.instances["chief-account"] = {
      ...config.instances["claude-two"], displayName: "Chief account",
      config: { cli, configDir: join(dataDir, "providers", "chief-account") },
    };
    if (options.crossProvider) config.instances["codex-last"] = {
      driver: "codex", displayName: "Codex final account",
      config: { cli: fileURLToPath(new URL("./testing/fake-codex-app-server.ts", import.meta.url)) },
      environment: { FAKE_CODEX_MODE: "resume", FAKE_CODEX_PROMPTS: thirdFile, FAKE_CODEX_DUMP: codexDump, FAKE_CODEX_REPLY: "Finished on Codex", FAKE_CODEX_ACCOUNT_EMAIL: "codex@example.test" },
    };
    config.accountBattery = { enabled: options.enabled !== false, order: { claudeAgent: ["claude", "claude-two"] } };
    if (options.defaultEnabled) delete config.accountBattery;
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
    const codexCalls = () => existsSync(codexDump) ? (JSON.parse(readFileSync(codexDump, "utf8")).calls ?? []) : [];
    await check({ api, control, release, dataDir, thirdPrompts: () => jsonLines(thirdFile), codexCalls, firstPrompts: () => jsonLines(firstFile), secondPrompts: () => jsonLines(secondFile), gate, bookedTo, evidence });
  } finally {
    evidence.push({ firstPrompts: jsonLines(firstFile), secondPrompts: jsonLines(secondFile) });
    const evidencePath = `${logPath}.account-battery.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}

async function batteryBot({ api, control }: BatteryFixture, name: string) {
  const { bot } = await control("new-bot", "--name", name);
  const threadId = bot.activeTaskId as string;
  await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: FIRST, updateBotDefault: true });
  const messages = async (): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages;
  const task = async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id)
    .tasks.find((entry: any) => entry.threadId === threadId);
  const send = (text: string) => control("send", "--bot", bot.id, "--task", threadId, "--text", text);
  const settled = async (done: (rows: any[]) => boolean) => {
    await expect.poll(async () => !(await task()).busy && done(await messages()), { timeout: 30_000, interval: 250 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await task()).busy).toBe(false);
  };
  return { bot, threadId, messages, task, send, settled };
}

const switches = (rows: any[]) => rows.filter((row) => row.tool?.name?.startsWith("recovery: Switched to"));
const carried = (rows: any[]) => rows.filter((row) => row.tool?.carry);
const limitRows = (rows: any[]) => rows.filter((row) => row.tool?.ok === false && /hit your session limit/.test(row.tool.name));
const lastReply = (rows: any[]) => rows.findLast((row) => row.role === "bot" && row.kind === "text");
const repliesAfter = (rows: any[], text: string) =>
  rows.slice(rows.findIndex((row) => row.role === "user" && row.text === text)).filter((row) => row.role === "bot" && row.kind === "text");

it("continues on account 2 with the conversation carried over, switches once, and comes back to account 1 after its reset", async () => {
  await withBatteryFixture({ resetsIn: 15 }, async (fixture) => {
    const { api, control, firstPrompts, secondPrompts, gate, bookedTo, evidence } = fixture;
    const chat = await batteryBot(fixture, "Battery switch");
    await chat.send("REMEMBER_BATTERY_HISTORY_7Q");
    await chat.settled((rows) => lastReply(rows)?.text === "hello from fake claude");
    expect(firstPrompts()).toHaveLength(1);
    expect(secondPrompts()).toHaveLength(0);

    writeFileSync(gate, "out of usage");
    const text = "SWITCH_ACCOUNTS_ONCE_8R";
    await chat.send(text);
    await chat.settled((rows) => lastReply(rows)?.text === "hello from account 2");
    expect(firstPrompts()).toHaveLength(2);
    expect(secondPrompts()).toHaveLength(1);
    const carried = promptText(secondPrompts()[0]);
    expect(carried).toContain("REMEMBER_BATTERY_HISTORY_7Q");
    expect(carried).toContain("hello from fake claude");
    expect(carried.split(text)).toHaveLength(2);
    const rows = await chat.messages();
    evidence.push({ afterSwitch: rows });
    expect(rows.filter((row) => row.role === "user" && row.text === text)).toHaveLength(1);
    expect(rows.find((row) => row.role === "user" && row.text === text).requestPending).toBe(false);
    expect(limitRows(rows)).toHaveLength(0);
    expect(rows.some((row) => row.role === "bot" && row.kind === "text" && /hit your/.test(row.text ?? ""))).toBe(false);
    expect(switches(rows).map((row) => row.tool.name)).toEqual([
      expect.stringMatching(/^recovery: Switched to Claude account 2 — Claude account 1 hit its 5-hour limit, resets (?:[A-Z][a-z]{2} \d{1,2} )?at \d{1,2}:\d\d [AP]M\.$/),
    ]);
    expect(lastReply(rows)).toMatchObject({ text: "hello from account 2", turnSucceeded: true });
    expect((await chat.task()).modelSelection ?? (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === chat.bot.id).modelSelection)
      .toMatchObject(FIRST);
    const resting = (await api("GET", "/api/config")).accountBattery;
    expect(resting.enabled).toBe(true);
    expect(resting.order.claudeAgent).toEqual(["claude", "claude-two"]);
    expect(Date.parse(resting.resting.claude.until)).toBeGreaterThan(Date.now() - 1_000);
    expect(resting.resting["claude-two"]).toBeUndefined();

    await chat.send("STILL_RESTING_3T");
    await chat.settled((rows) => rows.at(-1)?.role === "bot" && secondPrompts().length === 2);
    expect(firstPrompts()).toHaveLength(2);
    expect(secondPrompts()).toHaveLength(2);

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
    expect(sent.split(text)).toHaveLength(2);
    const rows = await chat.messages();
    evidence.push({ rows });
    expect(rows.filter((row) => row.role === "user")).toHaveLength(1);
    expect(rows.some((row) => row.tool?.name === "Bash")).toBe(true);
    expect(switches(rows)).toHaveLength(1);
    expect(rows.find((row) => row.role === "user" && row.text === text).requestPending).toBe(false);
  });
}, 120_000);

it("tries each account once and queues newer words while all accounts recharge", async () => {
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
    expect(limitRows(rows)).toHaveLength(1);
    expect(repliesAfter(rows, "BOTH_OUT_OF_USAGE_5U")).toEqual([]);
    expect(rows.findLast((row) => row.kind !== "digest")?.tool?.ok).toBe(false);
    const battery = (await api("GET", "/api/config")).accountBattery;
    expect(Object.keys(battery.resting).sort()).toEqual(["claude", "claude-two"]);
    const queued = await fixture.api("POST", `/api/bots/${chat.bot.id}/messages`, { threadId: chat.threadId, text: "ALL_RESTING_6W" });
    expect(queued.queued).toBe(true);
    expect(limitRows(await chat.messages())).toHaveLength(1);
    expect(firstPrompts()).toHaveLength(1);
    expect(secondPrompts()).toHaveLength(1);
    expect(switches(await chat.messages())).toHaveLength(1);
  });
}, 120_000);

it("waits when every account is out of usage, then picks up where it stopped once a limit resets", async () => {
  await withBatteryFixture({ secondOutOfUsage: true, resetsIn: 20 }, async (fixture) => {
    const { api, firstPrompts, secondPrompts, gate, bookedTo, evidence } = fixture;
    const chat = await batteryBot(fixture, "Battery walk away");
    writeFileSync(gate, "out of usage");
    const text = "WALK_AWAY_7K";
    await chat.send(text);
    await chat.settled((rows) => switches(rows).length === 1 && limitRows(rows).length === 1);
    const waiting = (await api("GET", "/api/config")).accountBattery.waiting;
    evidence.push({ waiting });
    expect(Object.keys(waiting)).toEqual([chat.threadId]);
    expect(Date.parse(waiting[chat.threadId])).toBeGreaterThan(Date.now());
    rmSync(gate);
    await expect.poll(async () => lastReply(await chat.messages())?.text, { timeout: 60_000, interval: 500 }).toBe("hello from fake claude");
    await chat.settled((rows) => lastReply(rows)?.text === "hello from fake claude");
    const rows = await chat.messages();
    evidence.push({ rows });
    expect(firstPrompts()).toHaveLength(2);
    expect(secondPrompts()).toHaveLength(1);
    expect(promptText(firstPrompts()[1])).toContain(text);
    expect(rows.filter((row) => row.role === "user")).toHaveLength(1);
    expect(rows.find((row) => row.role === "user" && row.text === text).requestPending).toBe(false);
    expect(switches(rows)).toHaveLength(1);
    expect(rows.filter((row) => row.tool?.name === "recovery: Picking up where it stopped, on Claude account 1.")).toHaveLength(1);
    expect(limitRows(rows)).toHaveLength(0);
    expect(rows.some((row) => row.tool?.name === "notice: Back on Claude account 1.")).toBe(false);
    expect((await api("GET", "/api/config")).accountBattery.waiting).toEqual({});
    await expect.poll(() => bookedTo(chat.threadId), { timeout: 10_000 }).toEqual(["claude", "claude-two", "claude"]);
  });
}, 150_000);

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
    expect(Object.keys((await api("GET", "/api/config")).accountBattery.resting)).toEqual(["claude"]);
    const refused = await api("PUT", "/api/config", { accountBattery: { enabled: true, order: { claudeAgent: ["claude", "nobody"] } } }, 400);
    expect(refused.error).toMatch(/nobody/);
    const saved = await api("PUT", "/api/config", { accountBattery: { enabled: true, order: { claudeAgent: ["claude-two", "claude"] } } });
    expect(saved.accountBattery).toMatchObject({ enabled: true, order: { claudeAgent: ["claude-two", "claude"] } });
  });
}, 120_000);

it("continues on the account the person picks with the battery off, stays there while the first rests, then comes back", async () => {
  await withBatteryFixture({ enabled: false, resetsIn: 25 }, async (fixture) => {
    const { api, firstPrompts, secondPrompts, gate, bookedTo, evidence } = fixture;
    const chat = await batteryBot(fixture, "Continue on");
    writeFileSync(gate, "out of usage");
    const text = "CONTINUE_ON_PICK_4P";
    await chat.send(text);
    await chat.settled((rows) => limitRows(rows).length === 1);
    expect(limitRows(await chat.messages())[0].tool.quota).toMatchObject({ kind: "session", instanceId: "claude", resetsAt: expect.any(String) });
    const continueOn = (instanceId: string, status?: number) =>
      api("POST", `/api/bots/${chat.bot.id}/continue-on`, { threadId: chat.threadId, instanceId }, status);
    expect((await continueOn("claude", 409)).error).toBe("That's the account that ran out.");
    expect(await continueOn("claude-two")).toEqual({ continued: true });
    await chat.settled((rows) => lastReply(rows)?.text === "hello from account 2");
    expect(firstPrompts()).toHaveLength(1);
    expect(secondPrompts()).toHaveLength(1);
    expect(promptText(secondPrompts()[0]).split(text)).toHaveLength(2);
    const rows = await chat.messages();
    evidence.push({ afterContinue: rows });
    expect(limitRows(rows)).toHaveLength(0);
    expect(rows.filter((row) => row.role === "user" && row.text === text)).toHaveLength(1);
    expect(switches(rows).map((row) => row.tool.name)).toEqual([
      expect.stringMatching(/^recovery: Switched to Claude account 2 — Claude account 1 hit its 5-hour limit, resets (?:[A-Z][a-z]{2} \d{1,2} )?at \d{1,2}:\d\d [AP]M\.$/),
    ]);
    expect((await api("GET", "/api/config")).accountBattery.enabled).toBe(false);

    await chat.send("STAYS_ON_PICK_5Q");
    await chat.settled((rows) => rows.at(-1)?.role === "bot" && secondPrompts().length === 2);
    expect(firstPrompts()).toHaveLength(1);

    rmSync(gate);
    await expect.poll(async () => Object.keys((await api("GET", "/api/config")).accountBattery.resting), { timeout: 40_000, interval: 500 }).toEqual([]);
    await chat.send("BACK_AFTER_PICK_6R");
    await chat.settled((rows) => rows.at(-1)?.role === "bot" && firstPrompts().length === 2);
    const final = await chat.messages();
    evidence.push({ final });
    expect(secondPrompts()).toHaveLength(2);
    expect(final.filter((row) => row.tool?.name === "notice: Back on Claude account 1.")).toHaveLength(1);
    await expect.poll(() => bookedTo(chat.threadId), { timeout: 10_000 }).toEqual(["claude", "claude-two", "claude-two", "claude"]);
  });
}, 150_000);


it("carries on after a mid-turn message, keeping both the original request and new words", async () => {
  await withBatteryFixture({ gated: true, afterTool: true, defaultEnabled: true }, async (fixture) => {
    const chat = await batteryBot(fixture, "Midturn battery");
    writeFileSync(fixture.gate, "limited");
    await chat.send("ORIGINAL_CARRY_REQUEST");
    await expect.poll(fixture.firstPrompts, { timeout: 20_000 }).toHaveLength(1);
    const steered = await fixture.api("POST", `/api/bots/${chat.bot.id}/messages`, { threadId: chat.threadId, text: "MIDTURN_CARRY_WORDS", deliver: "steer" });
    expect(steered.steered).toBe(true);
    writeFileSync(fixture.release, "finish");
    await chat.settled((rows) => lastReply(rows)?.text === "hello from account 2");
    expect(fixture.secondPrompts()).toHaveLength(1);
    const prompt = promptText(fixture.secondPrompts()[0]);
    expect(prompt).toContain("ORIGINAL_CARRY_REQUEST");
    expect(prompt).toContain("MIDTURN_CARRY_WORDS");
    expect(prompt).toContain("Do not redo what was already done.");
    expect(switches(await chat.messages())[0].tool.carry).toEqual({ from: "claude", to: "claude-two" });
    expect((await chat.messages()).find((row) => row.text === "ORIGINAL_CARRY_REQUEST").requestPending).toBe(false);
  });
}, 90_000);

it("tries the full account list through Codex after every Claude account runs out", async () => {
  await withBatteryFixture({ crossProvider: true, secondOutOfUsage: true, afterTool: true }, async (fixture) => {
    const chat = await batteryBot(fixture, "Cross-provider battery");
    writeFileSync(fixture.gate, "limited");
    await chat.send("CONTINUE_ALL_THE_WAY_TO_CODEX");
    await chat.settled((rows) => lastReply(rows)?.text === "Finished on Codex");
    expect(fixture.firstPrompts()).toHaveLength(1);
    expect(fixture.secondPrompts()).toHaveLength(1);
    expect(fixture.thirdPrompts()).toHaveLength(1);
    const prompt = JSON.stringify(fixture.thirdPrompts()[0]);
    expect(prompt).toContain("CONTINUE_ALL_THE_WAY_TO_CODEX");
    expect(prompt).toContain("Do not redo what was already done.");
    const rows = await chat.messages();
    expect(carried(rows).map((row) => row.tool.carry)).toEqual([
      { from: "claude", to: "claude-two" }, { from: "claude-two", to: "codex-last" },
    ]);
    expect(carried(rows).map((row) => row.tool.name)).toEqual([
      expect.stringMatching(/^recovery: Switched to Claude account 2 — /),
      "recovery: Claude is recharging. Continuing on Codex.",
    ]);
    expect((await chat.task()).modelSelection).toMatchObject(FIRST);
  });
}, 90_000);

it("keeps going on Codex when every Claude account is recharging, on the model the dog chose there, then sends the next message straight to Codex", async () => {
  await withBatteryFixture({ crossProvider: true, secondOutOfUsage: true, afterTool: true }, async (fixture) => {
    const chat = await batteryBot(fixture, "Cross-engine battery");
    await fixture.api("PATCH", `/api/bots/${chat.bot.id}`, { fallback: [{ instanceId: "codex-last", model: "gpt-page-two" }] });
    writeFileSync(fixture.gate, "limited");
    await chat.send("KEEP_GOING_ON_CODEX");
    await chat.settled((rows) => lastReply(rows)?.text === "Finished on Codex");
    const rows = await chat.messages();
    fixture.evidence.push({ afterCodex: rows });
    expect(limitRows(rows)).toHaveLength(0);
    expect(carried(rows).map((row) => row.tool.name).at(-1)).toBe("recovery: Claude is recharging. Continuing on Codex.");
    await expect.poll(() => fixture.codexCalls().filter((call) => call.method === "thread/start").length, { timeout: 10_000 }).toBe(1);
    const started = fixture.codexCalls().filter((call) => call.method === "thread/start");
    expect(started[0]!.params.model).toBe("gpt-page-two");
    await chat.send("NEXT_MESSAGE_STRAIGHT_TO_CODEX");
    await chat.settled((rows) => repliesAfter(rows, "NEXT_MESSAGE_STRAIGHT_TO_CODEX").some((row) => row.text === "Finished on Codex"));
    expect(fixture.firstPrompts()).toHaveLength(1);
    expect(fixture.secondPrompts()).toHaveLength(1);
    expect(fixture.thirdPrompts()).toHaveLength(2);
    expect(JSON.stringify(fixture.thirdPrompts()[1])).toContain("NEXT_MESSAGE_STRAIGHT_TO_CODEX");
    expect(limitRows(await chat.messages())).toHaveLength(0);
    expect((await chat.task()).modelSelection).toMatchObject(FIRST);
  });
}, 90_000);

it("does not leave Claude for Codex while the keep-going switch is off, and says the account is out", async () => {
  await withBatteryFixture({ crossProvider: true, secondOutOfUsage: true, enabled: false }, async (fixture) => {
    const chat = await batteryBot(fixture, "Switch off battery");
    writeFileSync(fixture.gate, "limited");
    await chat.send("STAY_ON_CLAUDE");
    await chat.settled((rows) => limitRows(rows).length === 1);
    const rows = await chat.messages();
    expect(carried(rows)).toHaveLength(0);
    expect(fixture.secondPrompts()).toHaveLength(0);
    expect(fixture.thirdPrompts()).toHaveLength(0);
    expect(fixture.codexCalls().filter((call) => call.method === "thread/start")).toHaveLength(0);
  });
}, 90_000);

it("finishes the same routine run once after automatically changing accounts", async () => {
  await withBatteryFixture({}, async (fixture) => {
    const chat = await batteryBot(fixture, "Routine battery");
    writeFileSync(fixture.gate, "limited");
    const { routine } = await fixture.api("POST", "/api/routines", { name: "Carry routine", prompt: "ROUTINE_CARRY_REQUEST", botId: chat.bot.id,
      enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
    const { run } = await fixture.api("POST", `/api/routines/${routine.id}/run`);
    const runs = async () => (await fixture.api("GET", "/api/routines")).runs.filter((entry: any) => entry.routineId === routine.id);
    await expect.poll(async () => (await runs()).find((entry: any) => entry.id === run.id)?.status, { timeout: 30_000 }).toBe("completed");
    expect(await runs()).toHaveLength(1);
    expect(fixture.secondPrompts()).toHaveLength(1);
    expect(promptText(fixture.secondPrompts()[0])).toContain("ROUTINE_CARRY_REQUEST");
  });
}, 90_000);

it("returns a coordinated result exactly once after the specialist changes accounts", async () => {
  await withBatteryFixture({ scripted: true }, async (fixture) => {
    const { api, control, dataDir } = fixture;
    const { bot: chief } = await control("new-bot", "--name", "Carry Chief", "--section", "Leadership");
    const { bot: specialist } = await control("new-bot", "--name", "Carry specialist", "--section", "Engineering");
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true });
    await api("PATCH", `/api/bots/${chief.id}/tasks/${chief.activeTaskId}`, { modelSelection: { ...FIRST, instanceId: "chief-account" }, updateBotDefault: true });
    await api("PATCH", `/api/bots/${specialist.id}/tasks/${specialist.activeTaskId}`, { modelSelection: FIRST, updateBotDefault: true });
    writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({
      [chief.id]: { turns: [
        { steps: [{ arguments: { bot_ids: [specialist.id], request_key: "carry-check", message: "CARRY_SPECIALIST_REQUEST" } }], reply: "Assigned" },
        { expectContextIncludes: ["SPECIALIST_CARRIED"], reply: "CHIEF_CARRY_DONE" },
      ] },
      [specialist.id]: { turns: [{ expectContextIncludes: ["CARRY_SPECIALIST_REQUEST"], reply: "SPECIALIST_CARRIED" }] },
    }));
    writeFileSync(fixture.gate, "limited");
    await control("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Ask Engineering to check this and report back.");
    const rows = async () => (await api("GET", `/api/threads/${chief.activeTaskId}/messages?limit=100`)).messages;
    await expect.poll(async () => (await rows()).filter((row: any) => row.text === "CHIEF_CARRY_DONE").length, { timeout: 30_000 }).toBe(1);
    const nodes = JSON.parse(readFileSync(join(dataDir, "room-handoffs.json"), "utf8")) as any[];
    const child = nodes.find((node) => node.botId === specialist.id);
    expect(child).toMatchObject({ status: "completed", reported: true, result: "SPECIALIST_CARRIED" });
    expect((await rows()).filter((row: any) => row.roomRequest?.id === child.id && row.roomRequest.phase === "result")).toHaveLength(1);
    expect(jsonLines(join(dataDir, "room-plan.json.evidence.jsonl")).filter((turn) => turn.botId === specialist.id)).toHaveLength(1);
  });
}, 90_000);


it.each([false, true])("continues a room member automatically, including an all-resting wait: %s", async (resting) => {
  await withBatteryFixture({ secondOutOfUsage: resting, resetsIn: resting ? 5 : 3_600 }, async (fixture) => {
    const chat = await batteryBot(fixture, "Room battery member");
    const { group } = await fixture.api("POST", "/api/groups", {
      name: "Battery room", memberIds: [chat.bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: chat.bot.id } },
    });
    writeFileSync(fixture.gate, "limited");
    await fixture.api("POST", `/api/groups/${group.id}/messages`, { text: "ROOM_CARRY_REQUEST" });
    const rows = async () => (await fixture.api("GET", `/api/threads/${group.threadId}/messages?limit=100`)).messages;
    if (resting) {
      await expect.poll(async () => Boolean((await fixture.api("GET", "/api/config")).accountBattery.waiting[group.threadId]), { timeout: 20_000 }).toBe(true);
      rmSync(fixture.gate);
    }
    await expect.poll(async () => lastReply(await rows())?.text, { timeout: 30_000 }).toBe(resting ? "hello from fake claude" : "hello from account 2");
    expect((await rows()).filter((row: any) => row.tool?.carry)).toHaveLength(resting ? 2 : 1);
    expect(fixture.secondPrompts()).toHaveLength(1);
    expect(promptText(fixture.secondPrompts()[0])).toContain("ROOM_CARRY_REQUEST");
    expect(promptText(fixture.secondPrompts()[0])).toContain("Do not redo what was already done.");
  });
}, 90_000);

it("keeps queued words until the carried-on request finishes", async () => {
  await withBatteryFixture({ gated: true }, async (fixture) => {
    const chat = await batteryBot(fixture, "Queued battery");
    writeFileSync(fixture.gate, "limited");
    await chat.send("ORIGINAL_QUEUED_CARRY");
    await expect.poll(fixture.firstPrompts, { timeout: 20_000 }).toHaveLength(1);
    const queued = await fixture.api("POST", `/api/bots/${chat.bot.id}/messages`, { threadId: chat.threadId, text: "QUEUED_CARRY_WORDS", deliver: "queue" });
    expect(queued.queued).toBe(true);
    writeFileSync(fixture.release, "finish");
    await chat.settled(() => fixture.secondPrompts().length === 2);
    expect(promptText(fixture.secondPrompts()[0])).toContain("ORIGINAL_QUEUED_CARRY");
    expect(promptText(fixture.secondPrompts()[1])).toContain("QUEUED_CARRY_WORDS");
    expect((await chat.messages()).filter((row) => row.role === "user" && row.text === "QUEUED_CARRY_WORDS")).toHaveLength(1);
  });
}, 90_000);


it("resumes the original coordination source after its account switches while a teammate works", async () => {
  await withBatteryFixture({ scripted: true, delegateBeforeLimit: true }, async (fixture) => {
    const { api, control, dataDir } = fixture;
    const { bot: chief } = await control("new-bot", "--name", "Switching chief", "--section", "Leadership");
    const { bot: specialist } = await control("new-bot", "--name", "Source specialist", "--section", "Engineering");
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true, parkDirectMessages: true });
    await api("PATCH", `/api/bots/${chief.id}/tasks/${chief.activeTaskId}`, { modelSelection: FIRST, updateBotDefault: true });
    await api("PATCH", `/api/bots/${specialist.id}/tasks/${specialist.activeTaskId}`, { modelSelection: { ...FIRST, instanceId: "chief-account" }, updateBotDefault: true });
    const carriedReady = join(dataDir, "source-carried-ready");
    const carriedRelease = join(dataDir, "source-carried-release");
    const workerReady = join(dataDir, "source-worker-ready");
    const workerRelease = join(dataDir, "source-worker-release");
    const planPath = join(dataDir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({
      [chief.id]: { turns: [
        { steps: [{ arguments: { bot_ids: [specialist.id], request_key: "source-carry", message: "SOURCE_SPECIALIST_REQUEST" } }], reply: "Assigned before quota" },
        { readyFile: carriedReady, gateFile: carriedRelease, reply: "Still assigned after switching" },
        { expectContextIncludes: ["SOURCE_SPECIALIST_DONE"], reply: "SOURCE_SYNTHESIS_DONE" },
        { expectContextIncludes: ["QUEUED_AFTER_SOURCE_SWITCH"], reply: "SOURCE_QUEUE_DRAINED" },
      ] },
      [specialist.id]: { turns: [{ readyFile: workerReady, gateFile: workerRelease, expectContextIncludes: ["SOURCE_SPECIALIST_REQUEST"], reply: "SOURCE_SPECIALIST_DONE" }] },
    }));
    writeFileSync(fixture.gate, "limited");
    await control("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Delegate this review and summarize the result.");
    await expect.poll(() => existsSync(carriedReady) && existsSync(workerReady), { timeout: 30_000 }).toBe(true);
    const rows = async () => (await api("GET", `/api/threads/${chief.activeTaskId}/messages?limit=200`)).messages;
    const nodes = () => JSON.parse(readFileSync(join(dataDir, "room-handoffs.json"), "utf8")) as any[];
    const rootId = nodes().find((node) => !node.parentId && node.botId === chief.id)!.id;
    const childId = nodes().find((node) => node.parentId === rootId)!.id;
    writeFileSync(workerRelease, "finish");
    await expect.poll(() => nodes().find((node) => node.id === childId)?.status, { timeout: 20_000 }).toBe("completed");
    expect(nodes().find((node) => node.id === rootId)?.status).toBe("source");
    expect(jsonLines(`${planPath}.evidence.jsonl`).filter((turn) => turn.botId === chief.id)).toHaveLength(1);
    const queued = await api("POST", `/api/bots/${chief.id}/messages`, { threadId: chief.activeTaskId, text: "QUEUED_AFTER_SOURCE_SWITCH", deliver: "queue" });
    expect(queued.queued).toBe(true);
    writeFileSync(carriedRelease, "finish");
    await expect.poll(async () => (await rows()).filter((row: any) => row.text === "SOURCE_SYNTHESIS_DONE").length, { timeout: 20_000 }).toBe(1);
    await expect.poll(async () => (await rows()).filter((row: any) => row.text === "SOURCE_QUEUE_DRAINED").length, { timeout: 20_000 }).toBe(1);
    expect(nodes().find((node) => node.id === rootId)?.status).toBe("completed");
    expect(nodes().filter((node) => node.parentId === rootId)).toHaveLength(1);
    expect((await rows()).filter((row: any) => row.roomRequest?.id === childId && row.roomRequest.phase === "result")).toHaveLength(1);
    expect((await rows()).find((row: any) => row.role === "user" && row.text === "Delegate this review and summarize the result.").requestPending).toBe(false);
  });
}, 90_000);
