import { describe, expect, it, vi } from "vitest";
import type { IndexMessage } from "../../../../shared/search-index-protocol.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
  WorkerEntrypoint: class {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
}));

const { searchIndex } = await import("../src/person-index-store.ts");
const { serveIndex, splitFeed, withinBudget } = await import("../src/index-routes.ts");
const { textSum } = await import("../../../../shared/search-index-query.ts");
const { coordinate } = await import("../src/coordinator.ts");
const { CAPABILITY_CLAIMS_HEADER } = await import("../src/edge-routes.ts");
const { nodeSql } = await import("./node-sql.ts");
type Claims = import("../../../../shared/signed-capability.ts").SignedCapabilityClaims;

const T0 = Date.UTC(2026, 10, 1);
const HOME = "h0123456789abcdef01234567";
const claims: Claims = { home: HOME, dog: "home", chat: "home", generation: "index", kind: "index", issuedAt: T0, expiresAt: T0 + 60_000 };

function message(chat: string, id: string, text: string, extra: Partial<IndexMessage> = {}): IndexMessage {
  return { chat, id, dog: chat.startsWith("a") ? "dog-a" : "dog-b", at: T0 + Number(id.replace(/\D/g, "")) * 1_000, role: "user", kind: "text", text, ...extra };
}

function seeded() {
  const index = searchIndex(nodeSql());
  index.feed({
    messages: [
      message("a-main", "m1", "We booked the dentist appointment for Monday"),
      message("a-main", "m2", "The invoice folder lives in Documents/Billing", { role: "bot", from: "Indigo" }),
      message("a-task", "m3", "Booking the flights to Lisbon on Friday", { peer: "Clover" }),
      message("b-main", "m4", "Dentist moved to Tuesday afternoon"),
      message("a-main", "m5", "Daily digest: dentist and invoices handled", { kind: "digest" }),
      message("a-main", "m6", "web_search", { kind: "activity", role: "bot" }),
    ],
    memory: [
      { dog: "dog-a", path: "memory/health.md", text: "Dentist is Dr. Rivera on Elm Street", mtime: T0, bytes: 34 },
      { dog: "dog-b", path: "memory/travel.md", text: "Prefers aisle seats on flights", mtime: T0, bytes: 30 },
      { dog: "dog-a", path: "MEMORY.md", text: "Dentist summary", mtime: T0, bytes: 15 },
    ],
  });
  return index;
}

describe("person search index", () => {
  it("recalls only from the chats it is given, with digests last, and keeps sender names", () => {
    const index = seeded();
    const hits = index.recall({ query: "dentist", chats: ["a-main", "a-task"] });
    expect(hits.map((hit) => hit.messageId)).toEqual(["m1", "m5"]);
    expect(hits[1].kind).toBe("digest");
    expect(hits[0].snippet).toContain("[dentist]");
    expect(index.recall({ query: "dentist", chats: ["b-main"] }).map((hit) => hit.messageId)).toEqual(["m4"]);
    expect(index.recall({ query: "dentist", chats: [] })).toEqual([]);
    expect(index.recall({ query: "booking flights", chats: ["a-task"] })[0]).toMatchObject({ messageId: "m3", peer: "Clover" });
    expect(index.recall({ query: "invoice", chats: ["a-main"] })[0]).toMatchObject({ messageId: "m2", from: "Indigo", role: "bot" });
  });

  it("matches any word with stems in the turn-start mode and honours a time range", () => {
    const index = seeded();
    expect(index.recall({ query: "remind me about bookings and dentists", chats: ["a-main", "a-task"], mode: "any" }).map((hit) => hit.messageId).sort())
      .toEqual(["m1", "m3", "m5"]);
    expect(index.recall({ query: "dentist", chats: ["a-main"], range: { since: T0 + 2_000 } }).map((hit) => hit.messageId)).toEqual(["m5"]);
    expect(index.recall({ query: "web_search", chats: ["a-main"] })).toEqual([]);
  });

  it("lists recent text newest first", () => {
    const index = seeded();
    expect(index.recent({ chats: ["a-main"], limit: 2 }).map((hit) => hit.messageId)).toEqual(["m2", "m1"]);
    expect(index.recent({ chats: ["a-main"], range: { until: T0 + 1_500 } }).map((hit) => hit.messageId)).toEqual(["m1"]);
  });

  it("finds substrings in text and tool names across chats or in one chat", () => {
    const index = seeded();
    expect(index.search({ query: "entis" }).map((hit) => hit.messageId)).toEqual(["m4", "m1"]);
    expect(index.search({ query: "WEB_SEA" })[0]).toMatchObject({ messageId: "m6", kind: "activity" });
    expect(index.search({ query: "entis", chats: ["b-main"] }).map((hit) => hit.messageId)).toEqual(["m4"]);
    const short = index.search({ query: "Li" });
    expect(short.map((hit) => hit.messageId)).toEqual(["m3", "m2"]);
    expect(short[0].snippet.slice(short[0].matchStart, short[0].matchStart + short[0].matchLength).toLowerCase()).toBe("li");
    expect(index.search({ query: '"quoted' })).toEqual([]);
  });

  it("searches memory per dog and leaves the summary files out of turn-start recall", () => {
    const index = seeded();
    expect(index.memory({ query: "dentist", dogs: ["dog-a"] }).map((hit) => hit.file).sort()).toEqual(["MEMORY.md", "memory/health.md"]);
    expect(index.memory({ query: "dentist", dogs: ["dog-a"], mode: "any" }).map((hit) => hit.file)).toEqual(["memory/health.md"]);
    expect(index.memory({ query: "flights", dogs: ["dog-a", "dog-b"] })).toEqual([expect.objectContaining({ dog: "dog-b", file: "memory/travel.md" })]);
  });

  it("applies edits, removals and whole-chat removals to every index", () => {
    const index = seeded();
    index.feed({ messages: [message("a-main", "m1", "We cancelled the orthodontist")] });
    expect(index.recall({ query: "Monday", chats: ["a-main"] })).toEqual([]);
    expect(index.search({ query: "orthodont" }).map((hit) => hit.messageId)).toEqual(["m1"]);
    index.feed({ messages: [message("a-main", "m6", "web_search now a reply", { kind: "text" })] });
    expect(index.recall({ query: "reply", chats: ["a-main"] }).map((hit) => hit.messageId)).toEqual(["m6"]);
    index.feed({ removeMessages: [{ chat: "a-main", id: "m1" }], removeChats: [{ chat: "b-main" }], removeMemory: [{ dog: "dog-a", path: "memory/health.md" }] });
    expect(index.search({ query: "orthodont" })).toEqual([]);
    expect(index.search({ query: "tuesday" })).toEqual([]);
    expect(index.memory({ query: "Rivera", dogs: ["dog-a"] })).toEqual([]);
    expect(index.stats()).toMatchObject({ messages: 4, memoryFiles: 2 });
    index.feed({ messages: [message("a-main", "m2", "The invoice folder lives in Documents/Billing", { role: "bot", from: "Indigo" })] });
    expect(index.stats().messages).toBe(4);
  });

  it("drops words too common to narrow a turn-start recall, and refuses a search made only of them", () => {
    const index = searchIndex(nodeSql(), { broadMatches: 3 });
    index.feed({ messages: ["the dentist", "the plan", "the lunch", "the dentist again", "plans for lunch"].map((body, i) => message("a-main", `m${i + 1}`, body)) });
    expect(index.recall({ query: "the dentist", chats: ["a-main"], mode: "any" }).map((hit) => hit.messageId).sort()).toEqual(["m1", "m4"]);
    expect(index.recall({ query: "the plans", chats: ["a-main"], mode: "any" }).map((hit) => hit.messageId).sort()).toEqual(["m2", "m5"]);
    expect(() => index.recall({ query: "the", chats: ["a-main"] })).toThrow(/too broad/);
    expect(index.recall({ query: "the lunch", chats: ["a-main"] }).map((hit) => hit.messageId).sort()).toEqual(["m3", "m5"]);
    expect(index.recall({ query: "the", chats: ["a-main"], mode: "any" })).toEqual([]);
  });

  it("refuses malformed batches whole, without applying part of them", () => {
    const index = seeded();
    expect(() => index.feed({ messages: [message("a-main", "m9", "fine"), message("bad chat", "m10", "nope")] })).toThrow(/not a valid id/);
    expect(index.search({ query: "fine" })).toEqual([]);
    expect(() => index.feed({ messages: Array.from({ length: 251 }, (_, i) => message("a-main", `x${i}`, "t")) })).toThrow(/at most/);
    expect(() => index.recall({ query: "x", chats: "a-main" as never })).toThrow(/list/);
  });
});

function both(index: never) {
  return { person: () => index, dog: () => index };
}

describe("dog shards", () => {
  it("keep their own chats and memory without a substring index, and say what they hold", () => {
    const index = searchIndex(nodeSql(), { substring: false });
    index.feed({ messages: [message("a-main", "m1", "We booked the dentist appointment for Monday")], memory: [{ dog: "dog-a", path: "memory/health.md", text: "Dentist is Dr. Rivera", mtime: T0, bytes: 21 }] });
    expect(index.recall({ query: "dentist", chats: ["a-main"] }).map((hit) => hit.messageId)).toEqual(["m1"]);
    expect(() => index.search({ query: "dentist" })).toThrow(/no substring search/);
    const held = index.has({ messages: [{ chat: "a-main", id: "m1" }, { chat: "a-main", id: "m9" }], memory: [{ dog: "dog-a", path: "memory/health.md" }] });
    expect(held.messages).toEqual([{ chat: "a-main", id: "m1", at: T0 + 1_000, kind: "text", sum: textSum("We booked the dentist appointment for Monday") }]);
    expect(held.memory).toEqual([{ dog: "dog-a", path: "memory/health.md", mtime: T0, sum: textSum("Dentist is Dr. Rivera") }]);
  });

  it("split a feed so every item reaches the person index unless told not to, and each dog it names", () => {
    const parts = splitFeed({
      messages: [{ ...message("a-main", "m1", "one"), dogs: ["dog-a"] }, { ...message("r-room", "m2", "two"), dogs: ["dog-a", "dog-b"] }, { ...message("r-room", "m3", "three"), dogs: ["dog-b"], person: false }],
      removeChats: [{ chat: "old", dogs: ["dog-b"] }],
      memory: [{ dog: "dog-a", path: "memory/a.md", text: "a", mtime: T0, bytes: 1 }],
      removeMemory: [{ dog: "dog-b", path: "memory/b.md", person: false }],
    });
    const of = (dog: string | null) => parts.find((part) => part.dog === dog)?.batch;
    expect(of(null)).toEqual({ messages: [message("a-main", "m1", "one"), message("r-room", "m2", "two")], removeChats: [{ chat: "old" }], memory: [{ dog: "dog-a", path: "memory/a.md", text: "a", mtime: T0, bytes: 1 }] });
    expect(of("dog-a")).toEqual({ messages: [message("a-main", "m1", "one"), message("r-room", "m2", "two")], memory: [{ dog: "dog-a", path: "memory/a.md", text: "a", mtime: T0, bytes: 1 }] });
    expect(of("dog-b")).toEqual({ messages: [message("r-room", "m2", "two"), message("r-room", "m3", "three")], removeChats: [{ chat: "old" }], removeMemory: [{ dog: "dog-b", path: "memory/b.md" }] });
    expect(() => splitFeed({ messages: [{ ...message("a-main", "m1", "one"), dogs: ["bad dog"] }] })).toThrow(/dog ids/);
  });
});

describe("index routes", () => {
  function request(operation: string, body: unknown, who: Claims = claims) {
    return new Request(`https://coordinator.internal/api/internal/index/${operation}`, {
      method: "POST", headers: { [CAPABILITY_CLAIMS_HEADER]: JSON.stringify(who) }, body: JSON.stringify(body),
    });
  }

  it("serves the container's index kind only, per home, and maps bad requests to 400", async () => {
    const homes: string[] = [];
    const index = seeded();
    const serve = (req: Request) => coordinate(req, () => { throw new Error("no dogs"); }, (home) => { homes.push(home); return { person: () => index, dog: () => index }; });
    const ok = await serve(request("recall", { query: "dentist", chats: ["a-main"] }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).result.map((hit: { messageId: string }) => hit.messageId)).toEqual(["m1", "m5"]);
    expect(homes).toEqual([HOME]);
    expect((await serve(request("recall", { query: "dentist", chats: ["a-main"] }, { ...claims, kind: "agents" }))).status).toBe(403);
    expect(await (await serve(request("recall", { query: "dentist", chats: ["bad chat"] }))).json()).toEqual({ error: "chats is not a valid id" });
    expect((await serve(request("drop", {}))).status).toBe(404);
    expect((await serve(request("stats", {}))).status).toBe(200);
    expect((await coordinate(request("stats", {}), () => { throw new Error("no dogs"); })).status).toBe(404);
  });

  it("sends a dog's reads to that dog's shard, searches to the person, and feeds to every shard named", async () => {
    const person = searchIndex(nodeSql());
    const shards = new Map<string, ReturnType<typeof searchIndex>>();
    const dog = (id: string) => shards.get(id) ?? shards.set(id, searchIndex(nodeSql(), { substring: false })).get(id)!;
    const serve = (req: Request) => coordinate(req, () => { throw new Error("no dogs"); }, () => ({ person: () => person, dog }));
    const fed = await serve(request("feed", { messages: [{ ...message("a-main", "m1", "dentist on Monday"), dogs: ["dog-a"] }, { ...message("b-main", "m2", "dentist on Tuesday"), dogs: ["dog-b"] }] }));
    expect((await fed.json()).result).toEqual({ applied: 4, shards: 3 });
    const recall = async (body: Record<string, unknown>) => ((await (await serve(request("recall", body))).json()).result as Array<{ messageId: string }>).map((hit) => hit.messageId);
    expect(await recall({ dog: "dog-a", query: "dentist", chats: ["a-main", "b-main"] })).toEqual(["m1"]);
    expect((await recall({ query: "dentist", chats: ["a-main", "b-main"] })).sort()).toEqual(["m1", "m2"]);
    expect((await serve(request("search", { dog: "dog-a", query: "dentist" }))).status).toBe(200);
    expect((await (await serve(request("stats", { dog: "dog-b" }))).json()).result.messages).toBe(1);
    expect((await serve(request("recall", { dog: "bad dog", query: "x", chats: [] }))).status).toBe(400);
  });

  it("answers unavailable inside the budget when the index is slow or broken, and the caller is not held", async () => {
    const slow = { ...seeded(), search: () => new Promise<never>(() => {}) } as never;
    const started = Date.now();
    const response = await serveIndex(request("search", { query: "dentist" }), claims, both(slow), { recall: 50, recent: 50, memory: 50, search: 50, has: 50, feed: 50, stats: 50 });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "index_unavailable", reason: "budget", budgetMs: 50 });
    expect(Date.now() - started).toBeLessThan(1_000);
    const broken = { ...seeded(), recall: () => { throw new Error("disk"); } } as never;
    expect(await (await serveIndex(request("recall", { query: "x", chats: ["a"] }), claims, both(broken))).json()).toEqual({ error: "index_unavailable", reason: "failed" });
    expect(await withinBudget(Promise.resolve(7), 10)).toBe(7);
  });
});
