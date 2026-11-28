import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import type { Message } from "../store.ts";


const { closeMessageDb, indexCoverageTable, indexMemoryFile, indexOutbox, insertMessage, readForIndex, recallMemory, recallMessages, recallMessagesOffThread, recentMessages, searchMessages, watchMessageWrites } = await import("../message-db.ts");
const { searchIndex } = await import("../../deploy/laterdog/home/src/person-index-store.ts");
const { splitFeed } = await import("../../deploy/laterdog/home/src/index-routes.ts");
const { compareHits } = await import("./search-index-feed.ts");
const { SearchIndexWiring } = await import("./search-index-wiring.ts");
type Index = ReturnType<typeof searchIndex>;

function nodeSql(database = new DatabaseSync(":memory:")) {
  return {
    all: <T>(query: string, ...params: Array<string | number | null>) => database.prepare(query).all(...params) as T[],
    script: (statements: string) => database.exec(statements),
    batch: (work: () => void) => {
      database.exec("BEGIN");
      try {
        work();
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    size: () => 0,
  };
}

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const WORDS = ("dentist invoice flights lisbon booking monday tuesday budget garden report deploy server folder memory recipe pasta " +
  "running marathon tickets concert insurance renewal passport visa hotel taxes receipts calendar meeting notes design launch " +
  "video phone battery charger groceries pharmacy refill school pickup soccer practice birthday party gift wrap paint fence").split(" ");
const FILLER = "the a and to of in we is it for on with that this was".split(" ");
const DOGS = ["dog-a", "dog-b", "dog-c"];
const CHATS = DOGS.flatMap((dog) => [`${dog}-main`, `${dog}-task`]);
const T0 = Date.UTC(2026, 9, 1);

const index = searchIndex(nodeSql());
const shards = new Map<string, Index>();
const shard = (dog: string) => shards.get(dog) ?? shards.set(dog, searchIndex(nodeSql(), { substring: false, broadMatches: Number.POSITIVE_INFINITY })).get(dog)!;
let indexUp = true;
const target = (request: { dog?: string }) => (request.dog ? shard(request.dog) : index);
const strip = <T extends { dog?: string }>({ dog: _dog, ...request }: T) => request;
const up = <T>(work: () => T): Promise<T | null> => Promise.resolve(indexUp ? work() : null);
const client = {
  feed: async (batch: Parameters<Index["feed"]>[0]) => {
    if (!indexUp) throw new Error("index down");
    for (const part of splitFeed(batch)) (part.dog ? shard(part.dog) : index).feed(part.batch);
  },
  recall: (request: Parameters<Index["recall"]>[0] & { dog?: string }) => up(() => target(request).recall(strip(request))),
  recent: (request: Parameters<Index["recent"]>[0] & { dog?: string }) => up(() => target(request).recent(strip(request))),
  memory: (request: Parameters<Index["memory"]>[0] & { dog?: string }) => up(() => target(request).memory(strip(request))),
  search: (request: Parameters<Index["search"]>[0]) => up(() => index.search(request)),
  has: (request: Parameters<Index["has"]>[0] & { dog?: string }) => up(() => target(request).has(strip(request))),
  files: (request: Parameters<Index["files"]>[0] & { dog?: string }) => up(() => target(request).files(strip(request))),
  stats: () => up(() => index.stats()),
};
const ROOM = "room-ab";
const owners = (chat: string) => (chat === ROOM ? ["dog-a", "dog-b"] : [chat.replace(/-(main|task)$/, "")]);
const wiring = new SearchIndexWiring({
  client,
  outbox: indexOutbox,
  read: readForIndex,
  coverage: {
    read: () => indexCoverageTable.read("h-test"),
    add: (chat, targets) => indexCoverageTable.add("h-test", chat, targets),
    drop: (chat) => indexCoverageTable.drop("h-test", chat),
    clear: () => indexCoverageTable.clear("h-test"),
  },
  ownersOf: owners,
  log: (line) => { if (line.includes("failed")) console.error(line); },
  pageGapMs: 0,
  feedDelayMs: 1,
});

beforeAll(async () => {
  const next = random(42);
  const pick = <T>(list: readonly T[]) => list[Math.floor(Math.pow(next(), 1.7) * list.length)]!;
  watchMessageWrites(wiring.wrote);
  for (let i = 0; i < 1_500; i++) {
    if (i === 900) wiring.setMode("shadow");
    const chat = i % 11 === 0 ? ROOM : pick(CHATS);
    const dog = owners(chat)[0]!;
    const length = 4 + Math.floor(next() * 30);
    const text = Array.from({ length }, () => (next() < 0.4 ? pick(FILLER) : pick(WORDS))).join(" ");
    const roll = next();
    const message = (roll < 0.02
      ? { id: `m${i}`, at: T0 + i * 1_000, role: "bot", kind: "routine.run", text: `routine finished ${text}` }
      : roll < 0.05
      ? { id: `m${i}`, at: T0 + i * 1_000, role: "bot", kind: "activity", tool: { name: pick(["web_search", "read_file", "send_text"]), ok: true } }
      : roll < 0.1
        ? { id: `m${i}`, at: T0 + i * 1_000, role: "bot", kind: "digest", text }
        : roll < 0.12
          ? { id: `m${i}`, at: T0 + i * 1_000, role: "user", kind: "text", text: `[Message from @Clover, another bot in this later.dog workspace] ${text}` }
          : { id: `m${i}`, at: T0 + i * 1_000, role: next() < 0.5 ? "user" : "bot", kind: "text", text, ...(next() < 0.2 ? { from: { botId: dog, name: `Name ${dog}` } } : {}) }) as unknown as Message;
    insertMessage(chat, message);
  }
  for (const dog of DOGS) {
    for (let f = 0; f < 6; f++) {
      const text = Array.from({ length: 40 }, () => pick(WORDS)).join(" ");
      const path = f === 0 ? "MEMORY.md" : `memory/topic-${f}.md`;
      indexMemoryFile(dog, path, text, { mtimeMs: T0 + f, bytes: text.length });
    }
  }
  await wiring.settled();
  return async () => {
    wiring.stop();
    watchMessageWrites(null);
    closeMessageDb();
  };
});

describe("the feed and backfill", () => {
  it("fill the person index with every message and each dog's shard with its own chats and rooms, and empty the outbox", () => {
    expect(index.stats().messages).toBe(1_500);
    expect(shard("dog-a").recent({ chats: [ROOM], limit: 1_000 }).length).toBe(shard("dog-b").recent({ chats: [ROOM], limit: 1_000 }).length);
    expect(shard("dog-c").recent({ chats: [ROOM], limit: 10 })).toEqual([]);
    expect(shard("dog-c").stats().memoryFiles).toBe(6);
    expect(indexOutbox.all()).toEqual([]);
    expect(wiring.status()).toMatchObject({ mode: "shadow", feed: { failing: false, pending: 0 }, backfill: { chatsQueued: 0 } });
  });
});

describe("shadow reads", () => {
  it("find no difference in data between the home's database and the dog shards, only rank order", async () => {
    for (const query of queries) {
      for (const dog of DOGS) {
        const chats = [`${dog}-main`, `${dog}-task`, ...(dog === "dog-c" ? [] : [ROOM])];
        await wiring.recall({ dog, query, chats, limit: 18, mode: "any" }, () => recallMessagesOffThread(query, chats, 18, undefined, "any"));
        await wiring.recall({ dog, query, chats, limit: 12 }, () => recallMessagesOffThread(query, chats, 12));
        await wiring.memory({ shard: dog, query, dogs: [dog], limit: 12, mode: "any" }, async () => [recallMemory(query, dog, 12, "any")]);
      }
      await wiring.recall({ query, chats: CHATS, limit: 12 }, () => recallMessagesOffThread(query, CHATS, 12));
      await wiring.memory({ query, dogs: DOGS, limit: 5 }, async () => DOGS.map((dog) => recallMemory(query, dog, 5)));
    }
    await wiring.recent({ dog: "dog-a", chats: ["dog-a-main", ROOM], limit: 12, range: {} }, async () => recentMessages(["dog-a-main", ROOM], {}, 12));
    await wiring.settled();
    const { shadow } = wiring.status();
    expect(shadow.samples).toEqual([]);
    expect(shadow.mismatch).toBe(0);
    expect(shadow.unavailable + shadow.skipped).toBe(0);
    expect(shadow.compared).toBe(queries.length * 11 + 1);
    expect(shadow.same).toBeGreaterThan(shadow.compared / 2);
  });

  it("leave out a chat written during the read and still compare the others", async () => {
    const before = wiring.status().shadow;
    const chats = ["dog-b-main", "dog-b-task"];
    await wiring.recall({ dog: "dog-b", query: "dentist", chats, limit: 1_000 }, async () => {
      const found = await recallMessagesOffThread("dentist", chats, 1_000);
      insertMessage("dog-b-main", { id: "m-during", at: T0 + 9_000_000, role: "user", kind: "text", text: "dentist again during the read" } as unknown as Message);
      return found;
    });
    await wiring.settled();
    const after = wiring.status().shadow;
    expect(after.mismatch).toBe(before.mismatch);
    expect(after.compared).toBe(before.compared + 1);
  });

  it("count a message the index lost as a mismatch", async () => {
    const before = wiring.status().shadow.mismatch;
    shard("dog-a").feed({ removeMessages: [{ chat: "dog-a-main", id: recallMessages("dentist", ["dog-a-main"], 1)[0]!.messageId }] });
    await wiring.recall({ dog: "dog-a", query: "dentist", chats: ["dog-a-main"], limit: 1_000 }, () => recallMessagesOffThread("dentist", ["dog-a-main"], 1_000));
    await wiring.settled();
    expect(wiring.status().shadow.mismatch).toBe(before + 1);
    expect(wiring.status().shadow.samples.at(-1)).toMatchObject({ op: "recall", shard: "dog", reason: "missing" });
  });
});

describe("prompt memory", () => {
  it("uses the turn's own snapshot when it comes in time, else the dog's shard, else the home's copy, and never the folder", async () => {
    const snapshot = new Map([["MEMORY.md", "from the folder"]]);
    expect(await wiring.promptMemory("dog-a", Promise.resolve(snapshot))).toBe(snapshot);
    const stuck = new Promise<null>(() => {});
    const fromIndex = await wiring.promptMemory("dog-a", stuck);
    expect(fromIndex.get("MEMORY.md")).toBe(shard("dog-a").files({ dogs: ["dog-a"] }).find((file) => file.path === "MEMORY.md")!.text);
    expect(fromIndex.size).toBe(6);
    indexUp = false;
    const fromHome = await wiring.promptMemory("dog-b", null);
    indexUp = true;
    expect([...fromHome.keys()].sort()).toEqual(shard("dog-b").files({ dogs: ["dog-b"] }).map((file) => file.path).sort());
    expect(wiring.status().prompt).toMatchObject({ snapshot: 1, index: 1, local: 1, mountReadsAvoided: 2 });
  });
});

describe("remote reads", () => {
  it("answer from the dog's shard, and from the home's database when the index is down or a chat is not covered yet", async () => {
    wiring.setMode("remote");
    try {
      const chats = ["dog-b-main", "dog-b-task"];
      const local = async () => [{ threadId: "local", messageId: "local", at: 0, role: "user", snippet: "local" }];
      expect(await wiring.recall({ dog: "dog-b", query: "invoice", chats, limit: 12 }, local)).toEqual(shard("dog-b").recall({ query: "invoice", chats, limit: 12 }));
      indexUp = false;
      expect(await wiring.recall({ dog: "dog-b", query: "invoice", chats, limit: 12 }, local)).toEqual(await local());
      indexUp = true;
      expect(await wiring.recall({ dog: "dog-b", query: "invoice", chats: [...chats, "dog-a-main"], limit: 12 }, local)).toEqual(await local());
      expect(wiring.status().remote).toMatchObject({ answered: 1, fellBack: 1 });
    } finally {
      wiring.setMode("shadow");
    }
  });
});

describe("switching the index off and on", () => {
  it("answers a chat written while the index was off from the home's database until that chat is fed again", async () => {
    const chats = ["dog-c-main", "dog-c-task"];
    const local = () => recallMessagesOffThread("zanzibar", chats, 12);
    wiring.setMode("off");
    insertMessage("dog-c-main", { id: "m-while-off", at: T0 + 9_500_000, role: "user", kind: "text", text: "zanzibar ferry tickets" } as unknown as Message);
    indexMemoryFile("dog-c", "memory/while-off.md", "zanzibar ferry notes", { mtimeMs: T0 + 99, bytes: 20 });
    wiring.setMode("remote");
    try {
      const before = wiring.status().remote;
      expect((await wiring.recall({ dog: "dog-c", query: "zanzibar", chats, limit: 12 }, local)).map((hit) => hit.messageId)).toEqual(["m-while-off"]);
      expect(wiring.status().remote).toEqual(before);
      await wiring.settled();
      expect(shard("dog-c").recall({ query: "zanzibar", chats, limit: 12 }).map((hit) => hit.messageId)).toEqual(["m-while-off"]);
      expect(shard("dog-c").memory({ query: "zanzibar", dogs: ["dog-c"], limit: 5 }).map((hit) => hit.file)).toEqual(["memory/while-off.md"]);
      expect((await wiring.recall({ dog: "dog-c", query: "zanzibar", chats, limit: 12 }, async () => [])).map((hit) => hit.messageId)).toEqual(["m-while-off"]);
    } finally {
      wiring.setMode("shadow");
    }
  });

  it("feeds every chat again when asked, answering from the home's database until each chat is fed", async () => {
    const chats = ["dog-a-main", "dog-a-task"];
    wiring.setMode("remote");
    try {
      wiring.refeed();
      expect(wiring.status().backfill.chatsCovered).toBe(0);
      const before = wiring.status().remote;
      expect(await wiring.recall({ dog: "dog-a", query: "invoice", chats, limit: 12 }, async () => [])).toEqual([]);
      expect(wiring.status().remote).toEqual(before);
      await wiring.settled();
      expect(wiring.status().backfill.chatsCovered).toBeGreaterThanOrEqual(CHATS.length);
      expect(indexOutbox.all()).toEqual([]);
      expect(await wiring.recall({ dog: "dog-a", query: "invoice", chats, limit: 12 }, async () => [])).toEqual(shard("dog-a").recall({ query: "invoice", chats, limit: 12 }));
    } finally {
      wiring.setMode("shadow");
    }
  });
});

const queries = [...WORDS.slice(0, 30), "dentist invoice", "flights lisbon booking", "the", "remind me about my passport and visa", "Taxes receipts", "garden-fence"];

describe("the person index answers exactly as the home's database does", () => {
  it("recall in both modes, scoped to one dog or several, with and without a time range", () => {
    let compared = 0;
    for (const query of queries) {
      for (const mode of ["all", "any"] as const) {
        for (const chats of [["dog-a-main"], ["dog-a-main", "dog-a-task"], CHATS]) {
          for (const range of [undefined, { since: T0 + 300_000, until: T0 + 1_200_000 }]) {
            const local = recallMessages(query, chats, 12, range, mode);
            const remote = index.recall({ query, chats, limit: 12, range, mode });
            expect(compareHits(local, remote), `${query} ${mode} ${chats.length}`).toEqual({ same: true, missing: [], extra: [] });
            expect(remote).toEqual(local);
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(queries.length * 12);
  });

  it("recent messages", () => {
    for (const chats of [["dog-b-task"], CHATS]) {
      for (const range of [{}, { since: T0 + 500_000 }, { until: T0 + 100_000 }]) {
        expect(index.recent({ chats, range, limit: 12 })).toEqual(recentMessages(chats, range, 12));
      }
    }
  });

  it("the search box, across all chats and in one chat", () => {
    for (const query of ["dent", "invoice fl", "web_se", "ta", "pasta", "xyz", "Lisbon"]) {
      expect(index.search({ query, limit: 40 })).toEqual(searchMessages(query, 40));
      expect(index.search({ query, limit: 40, chats: ["dog-c-main"] })).toEqual(searchMessages(query, 40, "dog-c-main"));
    }
  });

  it("memory recall per dog in both modes", () => {
    for (const query of queries) {
      for (const mode of ["all", "any"] as const) {
        const remote = index.memory({ query, dogs: ["dog-b"], limit: 12, mode }).map(({ dog: _dog, ...hit }) => hit);
        expect(remote).toEqual(recallMemory(query, "dog-b", 12, mode));
      }
    }
  });
});
