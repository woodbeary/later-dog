import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { afterEach, expect, it } from "vitest";
import { REMOTE_ENGINES_FILE, type ClaudeRemotePlan, type EngineOpener } from "./engine-placement.ts";
import type { EngineLink } from "./engine-remote.ts";
import { notePoolLoss, onPool, POOL_AVOID_MS, POOL_NOTE, poolAvoided, poolEngineOpener, poolLaunch, poolLink, takePoolLoss, type PoolService } from "./pool-opener.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fakeSocket() {
  return Object.assign(new EventEmitter(), { send: () => {}, close: () => {}, terminate: () => {}, ping: () => {} }) as unknown as WebSocket;
}

const quiet = { pingMs: 60_000, silentMs: 120_000 };

it("reports a pool engine lost when its stream drops, and not when the home or the engine ends it", async () => {
  const lost: string[] = [];
  const dropped = fakeSocket();
  poolLink(dropped, async () => true, quiet, (why) => lost.push(why));
  dropped.emit("close");
  const ended = fakeSocket();
  const link = poolLink(ended, async () => true, quiet, (why) => lost.push(why));
  link.close();
  const exited = fakeSocket();
  poolLink(exited, async () => true, quiet, (why) => lost.push(why));
  exited.emit("message", Buffer.from(JSON.stringify({ channel: "exit", code: 0 })), false);
  const idled = fakeSocket();
  poolLink(idled, async () => true, quiet, (why) => lost.push(why));
  idled.emit("message", Buffer.from(JSON.stringify({ channel: "closed", reason: "idle" })), false);
  expect(lost).toEqual(["pool stream closed"]);
});

it("keeps a chat off the pool for a while only after a loss that cut a turn short, never after a memory eviction or a loss between turns", () => {
  const now = Date.now();
  notePoolLoss("bot-a", "thread-a", "pool stream closed", now);
  expect(poolAvoided("bot-a", "thread-a", now + 500)).toBe(false);
  expect(takePoolLoss("bot-a", "thread-a", now + 1_000)).toBe(true);
  expect(takePoolLoss("bot-a", "thread-a", now + 2_000)).toBe(false);
  expect(poolAvoided("bot-a", "thread-a", now + 60_000)).toBe(true);
  expect(poolAvoided("bot-a", "thread-a", now + POOL_AVOID_MS + 1)).toBe(false);
  expect(poolAvoided("bot-a", "thread-b", now)).toBe(false);
  notePoolLoss("bot-b", "thread-a", "pool closed the engine: memory", now);
  expect(takePoolLoss("bot-b", "thread-a", now + 1_000)).toBe(true);
  expect(poolAvoided("bot-b", "thread-a", now + 1_000)).toBe(false);
  notePoolLoss("bot-c", "thread-a", "pool stream closed", now);
  expect(takePoolLoss("bot-c", "thread-a", now + 3 * 60_000)).toBe(false);
});

it("opens a chat whose pool engine was just lost on the dog's computer", async () => {
  const data = mkdtempSync(join(tmpdir(), "ldpool-loss-"));
  dirs.push(data);
  writeFileSync(join(data, REMOTE_ENGINES_FILE), JSON.stringify({ pool: { enabled: true } }));
  const opened: string[] = [];
  const computer: EngineOpener = { proxyPath: "/p", openBudgetMs: 1, async open(botId) { opened.push(botId); return {} as EngineLink; } };
  const unused: PoolService = { open: async () => { throw new Error("the pool was asked"); }, close: async () => true, stream: async () => { throw new Error("unused"); } };
  const plan = { threadId: "thread-lost", cli: { name: "@anthropic-ai/claude-code", version: "9" }, launch: { cli: "/home/dog/.laterdog-engine/cli/claude-code-9/node_modules/.bin/claude" } } as unknown as ClaudeRemotePlan;
  notePoolLoss("bot-lost", "thread-lost", "pool stream went silent");
  expect(takePoolLoss("bot-lost", "thread-lost")).toBe(true);
  await poolEngineOpener(computer, data, () => unused).open("bot-lost", plan);
  expect(opened).toEqual(["bot-lost"]);
  expect(readFileSync(join(data, "engine-placement.log"), "utf8")).toContain("lost this chat's engine");
});

it("tells a pool engine where its own files are", () => {
  const base = mkdtempSync(join(tmpdir(), "ldpool-note-"));
  dirs.push(base);
  const staging = join(base, "launch");
  mkdirSync(staging);
  const prompt = join(staging, "arg-3-prompt.md");
  writeFileSync(prompt, "You are a dog.");
  const plan = { threadId: "t", stagingDir: staging, cli: { name: "@anthropic-ai/claude-code", version: "9" },
    launch: { cli: "c", args: ["-p", "--append-system-prompt-file", prompt], cwd: "/w", env: {}, roots: [], outputIds: [], socketPath: "/home/dog/.laterdog-engine/run/x.sock", stateFile: "/s", lockFile: "/l", mcp: {}, hooks: [], hookEnv: {} } } as unknown as ClaudeRemotePlan;
  poolLaunch(plan, 1, "/proxy");
  expect(readFileSync(prompt, "utf8")).toBe(`You are a dog.${POOL_NOTE}`);
});

it("marks a chat as on the pool while its pool engine is open, and records a loss when the host drops it", async () => {
  const data = mkdtempSync(join(tmpdir(), "ldpool-on-"));
  dirs.push(data);
  writeFileSync(join(data, REMOTE_ENGINES_FILE), JSON.stringify({ pool: { enabled: true } }));
  const staging = join(data, "launch");
  mkdirSync(staging);
  const socket = fakeSocket();
  const service: PoolService = { open: async () => ({ status: 201, slot: 4, state: "warm" }), close: async () => true, stream: async () => socket };
  const computer: EngineOpener = { proxyPath: "/p", openBudgetMs: 1, async open() { throw new Error("the computer was asked"); } };
  const plan = { threadId: "thread-on", stagingDir: staging, cli: { name: "@anthropic-ai/claude-code", version: "9" },
    launch: { cli: "/home/dog/.laterdog-engine/cli/claude-code-9/node_modules/.bin/claude", args: [], cwd: "/w", env: {}, roots: [], outputIds: [], socketPath: "/home/dog/.laterdog-engine/run/x.sock", stateFile: "/s", lockFile: "/l", mcp: {}, hooks: [], hookEnv: {} } } as unknown as ClaudeRemotePlan;
  const link = await poolEngineOpener(computer, data, () => service).open("bot-on", plan);
  expect(onPool("thread-on")).toBe(true);
  const closed = new Promise((resolve) => link.once("close", resolve));
  socket.emit("close");
  await closed;
  expect(onPool("thread-on")).toBe(false);
  expect(poolAvoided("bot-on", "thread-on")).toBe(false);
  expect(takePoolLoss("bot-on", "thread-on")).toBe(true);
  expect(poolAvoided("bot-on", "thread-on")).toBe(true);
  expect(readFileSync(join(data, "engine-placement.log"), "utf8")).toContain("lost its pool engine (pool stream closed)");
});
