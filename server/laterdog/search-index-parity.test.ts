import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import type { Message } from "../store.ts";


const { closeMessageDb, indexMemoryFile, insertMessage, recallMemory, recallMessages, recentMessages, searchMessages } = await import("../message-db.ts");
const { searchIndex } = await import("../../deploy/laterdog/home/src/person-index-store.ts");
const { SearchIndexFeed, compareHits } = await import("./search-index-feed.ts");

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
const sent: Array<{ chat: string; message: Message; dog: string }> = [];

beforeAll(async () => {
  const next = random(42);
  const pick = <T>(list: readonly T[]) => list[Math.floor(Math.pow(next(), 1.7) * list.length)]!;
  const feed = new SearchIndexFeed(async (batch) => void index.feed(batch), { maxBatch: 300, delayMs: 1 });
  for (let i = 0; i < 1_500; i++) {
    const chat = pick(CHATS);
    const dog = chat.replace(/-(main|task)$/, "");
    const length = 4 + Math.floor(next() * 30);
    const text = Array.from({ length }, () => (next() < 0.4 ? pick(FILLER) : pick(WORDS))).join(" ");
    const roll = next();
    const message = (roll < 0.05
      ? { id: `m${i}`, at: T0 + i * 1_000, role: "bot", kind: "activity", tool: { name: pick(["web_search", "read_file", "send_text"]), ok: true } }
      : roll < 0.1
        ? { id: `m${i}`, at: T0 + i * 1_000, role: "bot", kind: "digest", text }
        : { id: `m${i}`, at: T0 + i * 1_000, role: next() < 0.5 ? "user" : "bot", kind: "text", text, ...(next() < 0.2 ? { from: { botId: dog, name: `Name ${dog}` } } : {}) }) as unknown as Message;
    insertMessage(chat, message);
    feed.message(dog, chat, message as never);
    sent.push({ chat, message, dog });
  }
  for (const dog of DOGS) {
    for (let f = 0; f < 6; f++) {
      const text = Array.from({ length: 40 }, () => pick(WORDS)).join(" ");
      const path = f === 0 ? "MEMORY.md" : `memory/topic-${f}.md`;
      indexMemoryFile(dog, path, text, { mtimeMs: T0 + f, bytes: text.length });
      feed.memory({ dog, path, text, mtime: T0 + f, bytes: text.length });
    }
  }
  await feed.flush();
  await feed.drained();
  return () => closeMessageDb();
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
