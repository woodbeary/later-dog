import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../../scripts/control-laterdog.ts";
import { waitForExit } from "../testing/cleanup.ts";

const FAKE = fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url));
const SERVER = fileURLToPath(new URL("../index.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const KNOBS = {
  LATERDOG_STALL_WATCH_MS: "2000",
  LATERDOG_STALL_QUIET_MS: "5000",
  LATERDOG_TURN_STALL_MS: "60000",
  LATERDOG_USAGE_WATCH_MS: "3000",
};

const ENGINE = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
const die = process.env.STALL_DIE_FILE;
const child = spawn(${JSON.stringify(FAKE)}, process.argv.slice(2), { stdio: "inherit", env: process.env });
const watch = setInterval(() => {
  if (!die || !existsSync(die)) return;
  rmSync(die, { force: true });
  child.kill("SIGKILL");
  process.exit(1);
}, 100);
child.on("exit", (code) => { clearInterval(watch); process.exit(code ?? 1); });
`;

interface Fixture {
  dataDir: string;
  logPath: string;
  release: string;
  die: string;
  api: (method: string, path: string, body?: unknown) => Promise<any>;
  control: (...args: string[]) => Promise<any>;
  restart: (beforeStart?: () => void, kill?: NodeJS.Signals) => Promise<void>;
  receipt: (name: string, value: unknown) => void;
}

async function withFixture(name: string, environment: Record<string, string>, check: (fixture: Fixture) => Promise<void>, serverEnv: Record<string, string> = {}) {
  const fixture = await launchVerificationServer({});
  const { dataDir, url, logPath } = fixture.info;
  const release = join(dataDir, "release");
  const die = join(dataDir, "die");
  const receipts: Record<string, unknown> = { scenario: name, startedAt: new Date().toISOString(), knobs: KNOBS };
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    expect(response.ok, `${method} ${path}`).toBe(true);
    return response.json();
  };
  const control = (...args: string[]) => runControlLaterDog([...args, "--url", url]);
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const engine = join(dataDir, "engine.mjs");
    writeFileSync(engine, ENGINE);
    chmodSync(engine, 0o755);
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.claude = { ...config.instances.claude, config: { ...config.instances.claude.config, cli: engine },
      environment: { FAKE_CLAUDE_RELEASE: release, STALL_DIE_FILE: die, FAKE_CLAUDE_TOOL_CALLS: "[]", ...environment } };
    writeFileSync(configPath, JSON.stringify(config));
    const restart = async (beforeStart?: () => void, kill: NodeJS.Signals = "SIGTERM") => {
      await waitForExit(server, { signal: kill });
      beforeStart?.();
      const log = openSync(logPath, "a", 0o600);
      server = spawn(process.execPath, ["--experimental-strip-types", SERVER], {
        cwd: ROOT, env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), ...KNOBS, ...serverEnv }, stdio: ["ignore", log, log],
      });
      closeSync(log);
      await expect.poll(async () => {
        try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
      }, { timeout: 30_000 }).toBe(true);
    };
    await restart();
    await check({ dataDir, logPath, release, die, api, control, restart, receipt: (key, value) => { receipts[key] = value; } });
    receipts.passed = true;
  } finally {
    receipts.endedAt = new Date().toISOString();
    const dir = process.env.STALL_RECEIPTS_DIR;
    const file = dir ? join(dir, `${name}.json`) : `${logPath}.${name}.json`;
    if (dir) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(receipts, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ scenario: name, receipt: file, logPath, fixtureRemoved: !existsSync(dataDir) }));
  }
}

async function dog(fixture: Fixture, name: string) {
  const { bot } = await fixture.control("new-bot", "--name", name) as any;
  const threadId = bot.activeTaskId as string;
  const rows = async (): Promise<any[]> => (await fixture.api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages;
  const me = async () => (await fixture.api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
  const busy = async () => Boolean((await me()).tasks?.find((task: any) => task.threadId === threadId)?.busy);
  const send = (text: string) => fixture.control("send", "--bot", bot.id, "--task", threadId, "--text", text);
  const states: Array<{ at: string; work: unknown }> = [];
  const sample = async () => {
    const work = (await me()).work;
    const last = states.at(-1);
    if (JSON.stringify(last?.work) !== JSON.stringify(work)) states.push({ at: new Date().toISOString(), work });
    return work;
  };
  return { bot, threadId, rows, busy, send, states, sample };
}

const replies = (rows: any[]) => rows.filter((row) => row.role === "bot" && row.kind === "text").map((row) => row.text);
const watchRows = (rows: any[]) => rows.filter((row) => row.tool?.pickup === "watch");
const plainRows = (rows: any[]) => rows.map((row) => ({ at: new Date(row.at).toISOString(), role: row.role, kind: row.kind,
  ...(row.text ? { text: row.text } : {}), ...(row.tool ? { tool: { name: row.tool.name, ok: row.tool.ok, ...(row.tool.detail ? { detail: row.tool.detail } : {}), ...(row.tool.pickup ? { pickup: row.tool.pickup } : {}) } } : {}),
  ...(row.turnSucceeded !== undefined ? { turnSucceeded: row.turnSucceeded } : {}) }));

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout: number, sample?: () => Promise<unknown>): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    await sample?.();
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last: ${JSON.stringify(value).slice(0, 2_000)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

it("an engine that exits mid-turn is carried on by the home with one plain line", async () => {
  await withFixture("engine-exits-mid-turn", { FAKE_CLAUDE_MODE: "hang" }, async (fixture) => {
    const chat = await dog(fixture, "Exit dog");
    await chat.send("Please write the release notes.");
    await until(chat.busy, Boolean, 30_000, chat.sample);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    writeFileSync(fixture.die, "now");
    await until(chat.busy, (busy) => !busy, 30_000, chat.sample);
    const afterExit = await chat.rows();
    writeFileSync(fixture.release, "go");
    const rows = await until(chat.rows, (all) => replies(all).includes("released"), 90_000, chat.sample);
    fixture.receipt("afterExit", plainRows(afterExit));
    fixture.receipt("rows", plainRows(rows));
    fixture.receipt("states", chat.states);
    expect(rows.filter((row) => row.role === "user")).toHaveLength(1);
    expect(watchRows(rows).map((row) => row.tool)).toEqual([{ name: "recovery: Exit dog stopped before finishing, so it is carrying on by itself.", ok: true, pickup: "watch" }]);
    const failed = rows.filter((row) => row.tool?.ok === false && !row.tool.pickup);
    fixture.receipt("failureRows", failed.map((row) => row.tool));
    expect(failed.map((row) => row.tool.name)).toContain("error: Exit dog stopped before it finished.");
    expect(failed.find((row) => row.tool.name === "error: Exit dog stopped before it finished.")?.tool.detail).toMatch(/^claude exited \S+ before result/);
  });
}, 240_000);

it("a turn that goes quiet is stopped with a reason and then carried on by itself", async () => {
  await withFixture("turn-goes-quiet", { FAKE_CLAUDE_MODE: "hang" }, async (fixture) => {
    const chat = await dog(fixture, "Quiet dog");
    await chat.send("Please check the build.");
    await until(chat.busy, Boolean, 30_000, chat.sample);
    const stalled = await until(chat.rows, (all) => all.some((row) => row.tool?.ok === false), 200_000, chat.sample);
    fixture.receipt("whenStalled", plainRows(stalled));
    writeFileSync(fixture.release, "go");
    const rows = await until(chat.rows, (all) => replies(all).includes("released"), 90_000, chat.sample);
    fixture.receipt("rows", plainRows(rows));
    fixture.receipt("states", chat.states);
    expect(rows.filter((row) => row.role === "user")).toHaveLength(1);
    expect(watchRows(rows).map((row) => row.tool)).toEqual([{ name: "recovery: Quiet dog stopped before finishing, so it is carrying on by itself.", ok: true, pickup: "watch" }]);
  });
}, 360_000);

it("a restart mid-turn leaves one notice and the work resumes, with no second carry-on", async () => {
  await withFixture("restart-mid-turn", { FAKE_CLAUDE_MODE: "hang" }, async (fixture) => {
    const chat = await dog(fixture, "Restart dog");
    await chat.send("Please tidy the changelog.");
    await until(chat.busy, Boolean, 30_000, chat.sample);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await fixture.restart(() => writeFileSync(fixture.release, "go"), "SIGKILL");
    const rows = await until(chat.rows, (all) => replies(all).includes("released"), 90_000, chat.sample);
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    const settled = await chat.rows();
    fixture.receipt("rows", plainRows(settled));
    fixture.receipt("states", chat.states);
    expect(rows.filter((row) => row.role === "user")).toHaveLength(1);
    expect(settled.filter((row) => row.tool?.pickup === "restart")).toHaveLength(1);
    expect(watchRows(settled)).toHaveLength(0);
  });
}, 240_000);

it("helpers working while the dog's own turn is over show as working, and nothing is carried on", async () => {
  await withFixture("helpers-while-quiet", { FAKE_CLAUDE_MODE: "puppies", FAKE_CLAUDE_PUPPIES_MS: "25000", FAKE_CLAUDE_PUPPIES_TICK_MS: "1000" }, async (fixture) => {
    const chat = await dog(fixture, "Helper dog");
    await chat.send("Survey the notes with two helpers.");
    await until(chat.busy, Boolean, 30_000, chat.sample);
    const quiet = await until(async () => ({ busy: await chat.busy(), work: await chat.sample() }), (now) => !now.busy, 60_000);
    fixture.receipt("whenTurnEnded", quiet);
    expect(quiet.work).toEqual({ kind: "running" });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await chat.sample();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const rows = await chat.rows();
    fixture.receipt("rows", plainRows(rows));
    fixture.receipt("states", chat.states);
    expect(watchRows(rows)).toHaveLength(0);
  });
}, 240_000);

it("in observe mode the watch only logs what it would do", async () => {
  await withFixture("observe-mode", { FAKE_CLAUDE_MODE: "hang" }, async (fixture) => {
    const chat = await dog(fixture, "Observed dog");
    await chat.send("Please write the release notes.");
    await until(chat.busy, Boolean, 30_000, chat.sample);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    writeFileSync(fixture.die, "now");
    await until(chat.busy, (busy) => !busy, 30_000, chat.sample);
    const logged = await until(async () => readFileSync(fixture.logPath, "utf8").split("\n").filter((line) => line.includes("stall watch (observe)")),
      (lines) => lines.length > 0, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const rows = await chat.rows();
    fixture.receipt("observeLines", logged);
    fixture.receipt("rows", plainRows(rows));
    fixture.receipt("states", chat.states);
    expect(watchRows(rows)).toHaveLength(0);
    expect(logged).toHaveLength(1);
    expect(replies(rows)).not.toContain("released");
  }, { LATERDOG_STALL_WATCH: "observe" });
}, 240_000);
