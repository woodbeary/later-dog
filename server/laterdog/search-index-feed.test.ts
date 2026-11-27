import { describe, expect, it, vi } from "vitest";
import type { IndexFeedBatch } from "../../shared/search-index-protocol.ts";
import { capabilityKey, verifyCapability } from "../../shared/signed-capability.ts";
import { SearchIndexFeed, compareHits, searchIndexClient, type FeedEntry, type FeedKey } from "./search-index-feed.ts";

const HOME = "h0123456789abcdef01234567";

function resolver(texts: Map<string, string>) {
  return async (entries: FeedEntry[]): Promise<IndexFeedBatch> => {
    const batch: IndexFeedBatch = {};
    for (const entry of entries) {
      const key = entry.key;
      const shards = { dogs: [...entry.dogs], person: entry.person || entry.auto };
      if (key.kind === "chat") (batch.removeChats ??= []).push({ chat: key.chat, ...shards });
      else if (key.kind === "memory") (batch.memory ??= []).push({ dog: key.dog, path: key.path, text: texts.get(key.path) ?? "", mtime: 1, bytes: 1, ...shards });
      else if (texts.has(key.id)) (batch.messages ??= []).push({ chat: key.chat, id: key.id, dog: "dog", at: 1, role: "user", kind: "text", text: texts.get(key.id)!, ...shards });
      else (batch.removeMessages ??= []).push({ chat: key.chat, id: key.id, ...shards });
    }
    return batch;
  };
}

describe("index feed", () => {
  it("batches keys, reads each one's latest state when it sends, and drops a removed chat's pending messages", async () => {
    const batches: IndexFeedBatch[] = [];
    const texts = new Map([["a", "first"]]);
    const sent: FeedKey[][] = [];
    const feed = new SearchIndexFeed(async (batch) => void batches.push(batch), resolver(texts), { maxBatch: 2, delayMs: 5, onSent: (keys) => sent.push(keys) });
    feed.message("chat-1", "a");
    texts.set("a", "second");
    feed.message("chat-1", "a");
    feed.message("chat-2", "b");
    feed.removeChat("chat-2", { dogs: ["dog-b"] });
    feed.memory("dog", "memory/x.md", { dogs: ["dog"], person: false });
    feed.message("chat-1", "gone");
    expect(feed.busy(["chat-1"])).toBe(true);
    expect(feed.busy(["chat-9"])).toBe(false);
    await feed.drained();
    expect(batches).toEqual([
      { messages: [expect.objectContaining({ id: "a", text: "second", person: true, dogs: [] })], removeChats: [{ chat: "chat-2", dogs: ["dog-b"], person: false }] },
      { memory: [expect.objectContaining({ path: "memory/x.md", dogs: ["dog"], person: false })], removeMessages: [{ chat: "chat-1", id: "gone", dogs: [], person: true }] },
    ]);
    expect(sent.flat().map((key) => key.kind)).toEqual(["message", "chat", "message"]);
    expect(feed.state).toMatchObject({ pending: 0, sent: 4, failures: 0 });
    expect(feed.busy(["chat-1"])).toBe(false);
  });

  it("merges the shards a key is sent to and keeps it automatic once a write asked for it", async () => {
    const entries: FeedEntry[][] = [];
    const feed = new SearchIndexFeed(async () => {}, async (taken) => { entries.push(taken); return {}; }, { delayMs: 5 });
    feed.message("chat", "a", { dogs: ["dog-a"], person: false });
    feed.message("chat", "a", { dogs: ["dog-b"] });
    feed.message("chat", "a");
    await feed.drained();
    expect(entries.flat()).toEqual([{ key: { kind: "message", chat: "chat", id: "a" }, auto: true, dogs: new Set(["dog-a", "dog-b"]), person: false }]);
  });

  it("keeps keys through failures and sends them once the index answers", async () => {
    vi.useFakeTimers();
    try {
      let up = false;
      const batches: IndexFeedBatch[] = [];
      const texts = new Map([["a", "one"]]);
      const feed = new SearchIndexFeed(async (batch) => {
        if (!up) throw new Error("down");
        batches.push(batch);
      }, resolver(texts), { delayMs: 10, retryMs: [100, 200] });
      feed.message("chat", "a");
      await vi.advanceTimersByTimeAsync(20);
      expect(feed.state).toMatchObject({ failures: 1, lastError: "down" });
      expect(feed.failing).toBe(true);
      texts.set("a", "two");
      feed.message("chat", "a");
      await vi.advanceTimersByTimeAsync(50);
      expect(batches).toEqual([]);
      up = true;
      await vi.advanceTimersByTimeAsync(100);
      expect(batches).toEqual([{ messages: [expect.objectContaining({ text: "two" })] }]);
      expect(feed.state).toMatchObject({ pending: 0, failures: 1, sent: 1 });
      expect(feed.failing).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops everything it holds past its cap and says so, so every chat is fed again", () => {
    let dropped = 0;
    const feed = new SearchIndexFeed(async () => { throw new Error("down"); }, resolver(new Map()), { maxPending: 3, delayMs: 60_000, onDrop: () => { dropped += 1; } });
    for (let i = 0; i < 5; i++) feed.message("chat", `m${i}`);
    expect(feed.state).toMatchObject({ pending: 1, dropped: 4 });
    expect(dropped).toBe(1);
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
