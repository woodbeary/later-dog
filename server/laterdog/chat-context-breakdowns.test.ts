import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChatContextBreakdowns, type ContextEngine } from "./chat-context-breakdowns.ts";
import type { EngineContextReply } from "./engine-context-ask.ts";

const ANSWER = {
  categories: [
    { id: "system_prompt", name: "System prompt", tokens: 2_000, kind: "used" },
    { id: "messages", name: "Messages", tokens: 8_000, kind: "used" },
    { id: "free_space", name: "Free space", tokens: 190_000, kind: "free" },
  ],
  totalTokens: 10_000,
  maxTokens: 200_000,
  memoryFiles: [{ path: "/home/person/notes/CLAUDE.md", type: "User", tokens: 10 }],
};

let dir: string;
let file: string;
let replies: EngineContextReply[];
let asked: string[];
let clock: number;

const engine: ContextEngine = {
  contextUsage: async (threadId) => {
    asked.push(threadId);
    return replies.shift() ?? { kind: "none" };
  },
};

const make = (engines: Record<string, ContextEngine | undefined> = { claude: engine }) =>
  new ChatContextBreakdowns({ file, engine: (id) => engines[id], now: () => clock });

const dispatchClaude = (store: ChatContextBreakdowns, threadId = "t1") =>
  store.dispatched(threadId, { driverKind: "claudeAgent", instanceId: "claude", sections: [{ id: "persona", bytes: 400 }], tools: null });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "context-breakdowns-"));
  file = join(dir, "context-breakdowns.json");
  replies = [];
  asked = [];
  clock = 1_000;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the latest breakdown kept for each chat", () => {
  it("knows nothing about a chat that has not run a turn", async () => {
    expect(await make().read("ghost", undefined)).toBeNull();
    expect(asked).toEqual([]);
  });

  it("asks the engine after a turn, keeps the answer with its time, and serves it once the engine is gone", async () => {
    const store = make();
    dispatchClaude(store);
    replies.push({ kind: "answer", answer: ANSWER });
    expect((await store.afterTurn("t1"))?.total).toBe(10_000);
    clock = 99_000;
    const kept = await store.read("t1", undefined);
    expect(kept).toMatchObject({ at: 1_000, source: "engine", total: 10_000, window: 200_000 });
    expect(asked).toEqual(["t1", "t1"]);
    const reopened = await make({}).read("t1", undefined);
    expect(reopened).toEqual(kept);
  });

  it("asks again when the view opens and keeps the newer answer", async () => {
    const store = make();
    dispatchClaude(store);
    replies.push({ kind: "answer", answer: ANSWER });
    await store.afterTurn("t1");
    clock = 5_000;
    replies.push({ kind: "answer", answer: { ...ANSWER, totalTokens: 12_000 } });
    expect(await store.read("t1", undefined)).toMatchObject({ at: 5_000, total: 12_000 });
  });

  it("keeps the last answer when the engine refuses, has no turn yet, or says nothing", async () => {
    const store = make();
    dispatchClaude(store);
    expect(await store.afterTurn("t1")).toBeNull();
    replies.push({ kind: "not-yet" }, { kind: "answer", answer: ANSWER }, { kind: "refused" });
    expect(await store.read("t1", undefined)).toBeNull();
    await store.afterTurn("t1");
    expect((await store.read("t1", undefined))?.total).toBe(10_000);
  });

  it("calls a count fresh when it was taken after the last turn and matches the chat's number", async () => {
    const store = make();
    dispatchClaude(store);
    replies.push({ kind: "answer", answer: ANSWER });
    await store.afterTurn("t1");
    const read = await store.read("t1", { tokens: 10_150, window: 200_000 });
    expect(read).toMatchObject({ total: 10_000 });
    expect(read?.stale).toBeUndefined();
  });

  it("marks a count stale when a later turn ended without a new answer", async () => {
    const store = make();
    dispatchClaude(store);
    replies.push({ kind: "answer", answer: ANSWER });
    await store.afterTurn("t1");
    clock = 600_000;
    dispatchClaude(store);
    await store.afterTurn("t1");
    expect(await store.read("t1", undefined)).toMatchObject({ at: 1_000, total: 10_000, stale: true });
    expect(await make({}).read("t1", undefined)).toMatchObject({ at: 1_000, stale: true });
  });

  it("marks a count stale when its total is more than 2% off the chat's number", async () => {
    const store = make();
    dispatchClaude(store);
    replies.push({ kind: "answer", answer: ANSWER });
    await store.afterTurn("t1");
    expect(await store.read("t1", { tokens: 150_000, window: 200_000 })).toMatchObject({ total: 10_000, stale: true });
    expect((await store.read("t1", { tokens: 10_200, window: 200_000 }))?.stale).toBeUndefined();
  });

  it("never estimates for an engine that counts for itself", async () => {
    const store = make();
    dispatchClaude(store);
    expect(await store.read("t1", { tokens: 40_000, window: 200_000 })).toBeNull();
  });

  it("estimates for other engines from what the home sent, with the engine's own total", async () => {
    const store = make({});
    store.dispatched("t2", { driverKind: "codex", instanceId: "codex", sections: [{ id: "persona", bytes: 4_000 }, { id: "memory", bytes: 2_000 }], tools: { loadedBytes: 8_000, notLoadedBytes: 0 } });
    expect(await store.read("t2", { tokens: 20_000, window: 100_000 })).toEqual({
      at: 1_000,
      source: "estimate",
      total: 20_000,
      window: 100_000,
      parts: [
        { id: "conversation", tokens: 16_500 },
        { id: "tools", tokens: 2_000 },
        { id: "instructions", tokens: 1_000 },
        { id: "memory", tokens: 500 },
        { id: "free", tokens: 80_000 },
      ],
    });
    expect(await store.read("t2", undefined)).toBeNull();
  });

  it("forgets an engine count when the chat moves to another engine", async () => {
    const store = make();
    dispatchClaude(store);
    replies.push({ kind: "answer", answer: ANSWER });
    await store.afterTurn("t1");
    store.dispatched("t1", { driverKind: "codex", instanceId: "codex", sections: [], tools: null });
    expect(await store.read("t1", undefined)).toBeNull();
  });

  it("saves sizes only, never what the engine said about files or tools", async () => {
    const store = make();
    dispatchClaude(store);
    replies.push({ kind: "answer", answer: ANSWER });
    await store.afterTurn("t1");
    const saved = readFileSync(file, "utf8");
    expect(saved).not.toContain("CLAUDE.md");
    expect(saved).not.toContain("/home/person");
    expect(saved).not.toContain("persona");
  });
});
