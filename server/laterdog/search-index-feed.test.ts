import { describe, expect, it, vi } from "vitest";
import type { IndexFeedBatch } from "../../shared/search-index-protocol.ts";
import { capabilityKey, verifyCapability } from "../../shared/signed-capability.ts";
import { SearchIndexFeed, compareHits, indexMessage, searchIndexClient } from "./search-index-feed.ts";

const HOME = "h0123456789abcdef01234567";
const text = (id: string, body: string) => ({ id, at: 1_000, role: "user", kind: "text", text: body });

describe("index feed", () => {
  it("maps messages the way the home's database indexes them", () => {
    expect(indexMessage("dog", "chat", { id: "1", at: 5, role: "bot", kind: "activity", tool: { name: "web_search" } })).toMatchObject({ kind: "activity", text: "web_search" });
    expect(indexMessage("dog", "chat", { id: "2", at: 5, role: "bot", kind: "image" }).text).toBe("");
    expect(indexMessage("dog", "chat", { ...text("3", "hi"), from: { name: "Indigo" } }, "Clover")).toMatchObject({ from: "Indigo", peer: "Clover" });
    expect(indexMessage("dog", "chat", text("4", "x".repeat(70_000))).text).toHaveLength(64_000);
  });

  it("batches, keeps only the latest change per message, and drops a removed chat's pending changes", async () => {
    const batches: IndexFeedBatch[] = [];
    const feed = new SearchIndexFeed(async (batch) => void batches.push(batch), { maxBatch: 2, delayMs: 5 });
    feed.message("dog", "chat-1", text("a", "first"));
    feed.message("dog", "chat-1", text("a", "second"));
    feed.message("dog", "chat-2", text("b", "gone"));
    feed.removeChat("chat-2");
    feed.memory({ dog: "dog", path: "memory/x.md", text: "note", mtime: 1, bytes: 4 });
    feed.removeMemory("dog", "memory/y.md");
    await feed.drained();
    expect(batches).toEqual([
      { messages: [expect.objectContaining({ id: "a", text: "second" })], removeChats: ["chat-2"] },
      { memory: [expect.objectContaining({ path: "memory/x.md" })], removeMemory: [{ dog: "dog", path: "memory/y.md" }] },
    ]);
    expect(feed.state).toMatchObject({ pending: 0, sent: 4, failures: 0 });
  });

  it("keeps changes through failures and sends them once the index answers, newer changes winning", async () => {
    vi.useFakeTimers();
    try {
      let up = false;
      const batches: IndexFeedBatch[] = [];
      const feed = new SearchIndexFeed(async (batch) => {
        if (!up) throw new Error("down");
        batches.push(batch);
      }, { delayMs: 10, retryMs: [100, 200] });
      feed.message("dog", "chat", text("a", "one"));
      await vi.advanceTimersByTimeAsync(20);
      expect(feed.state.failures).toBe(1);
      feed.message("dog", "chat", text("a", "two"));
      await vi.advanceTimersByTimeAsync(50);
      expect(batches).toEqual([]);
      up = true;
      await vi.advanceTimersByTimeAsync(100);
      expect(batches).toEqual([{ messages: [expect.objectContaining({ text: "two" })] }]);
      expect(feed.state).toMatchObject({ pending: 0, failures: 1, sent: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps what it holds and says a backfill is needed instead of growing without bound", async () => {
    const feed = new SearchIndexFeed(async () => { throw new Error("down"); }, { maxPending: 3, delayMs: 60_000 });
    for (let i = 0; i < 5; i++) feed.message("dog", "chat", text(`m${i}`, "t"));
    expect(feed.state).toMatchObject({ pending: 3, dropped: 2, needsBackfill: true });
    feed.stop();
  });
});

describe("index client", () => {
  it("signs each call with the container's index capability and returns results", async () => {
    const seen: Request[] = [];
    const client = searchIndexClient({
      origin: `https://${HOME}-home.later.dog`, home: HOME, bootstrapSecret: "bootstrap", now: () => 1_800_000_000_000,
      fetch: async (input, init) => {
        seen.push(new Request(input, init));
        return Response.json({ ok: true, result: [{ threadId: "c", messageId: "m" }] });
      },
    });
    expect(await client.recall({ query: "dentist", chats: ["c"] })).toEqual([{ threadId: "c", messageId: "m" }]);
    expect(seen[0].url).toBe(`https://${HOME}-home.later.dog/api/internal/index/recall`);
    const token = seen[0].headers.get("authorization")!.slice("Bearer ".length);
    const check = await verifyCapability(await capabilityKey("bootstrap"), token, { home: HOME, now: 1_800_000_000_000, kinds: ["index"] });
    expect(check).toMatchObject({ ok: true, claims: { kind: "index", home: HOME } });
    await client.search({ query: "x" });
    expect(seen[1].headers.get("authorization")).toBe(seen[0].headers.get("authorization"));
  });

  it("answers null when the index is unavailable or slower than its budget, and throws for a failed feed", async () => {
    const down = searchIndexClient({ origin: "https://h", home: HOME, bootstrapSecret: "b", fetch: async () => Response.json({ error: "index_unavailable" }, { status: 503 }) });
    expect(await down.recall({ query: "x", chats: ["c"] })).toBeNull();
    await expect(down.feed({ messages: [] })).rejects.toThrow(/503/);
    const slow = searchIndexClient({
      origin: "https://h", home: HOME, bootstrapSecret: "b", budgets: { recall: 20 },
      fetch: (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    });
    const started = Date.now();
    expect(await slow.recall({ query: "x", chats: ["c"] })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("compares local and remote hits for shadow reads", () => {
    const a = { threadId: "c", messageId: "1" };
    const b = { threadId: "c", messageId: "2" };
    expect(compareHits([a, b], [a, b])).toEqual({ same: true, missing: [], extra: [] });
    expect(compareHits([a, b], [b, a]).same).toBe(false);
    expect(compareHits([a], [b])).toEqual({ same: false, missing: ["c/1"], extra: ["c/2"] });
  });
});
