import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb, closeMessageSearch, deleteThread, indexMemoryFile, insertMessage, recallMemory, recallMemoryOffThread, recallMessages, recallMessagesOffThread, recentMessages, recentMessagesOffThread, searchMessages, searchMessagesAsync } from "./message-db.ts";
import { MessageSearchWorker, SEARCH_TOO_SLOW, WITHIN_BUDGET } from "./message-search-worker.ts";

beforeEach(async () => {
  await closeMessageSearch();
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  insertMessage("a", { id: "m1", at: 1, role: "user", kind: "text", text: "Literal 10%_\\ path. Hello 世界. " + "long ".repeat(100) + "needle" });
  insertMessage("b", { id: "m2", at: 2, role: "bot", kind: "activity", tool: { name: "Run HELLO migration", ok: true } });
});
afterEach(async () => { await closeMessageSearch(); closeMessageDb(); });

it("preserves literal search, tool names, snippets, order, limits and thread scope", async () => {
  for (const query of ["hello", "10%_\\", "世界", "needle", "absent", "  "]) {
    for (const thread of [undefined, "a", "b", "missing"]) {
      expect(await searchMessagesAsync(query, 1, thread)).toEqual(searchMessages(query, 1, thread));
    }
  }
});

it("sees committed writes and deletions without restarting the worker", async () => {
  expect(await searchMessagesAsync("newly committed")).toEqual([]);
  insertMessage("a", { id: "new", at: 3, role: "user", kind: "text", text: "newly committed" });
  expect(await searchMessagesAsync("newly committed")).toMatchObject([{ threadId: "a", messageId: "new" }]);
  deleteThread("a");
  expect(await searchMessagesAsync("newly committed")).toEqual([]);
});

it("bounds outstanding scans and releases capacity after completion", async () => {
  const pending = Array.from({ length: 8 }, () => searchMessagesAsync("hello"));
  await expect(searchMessagesAsync("hello")).rejects.toMatchObject({ status: 503 });
  expect((await Promise.all(pending)).every(hits => hits.length === 2)).toBe(true);
  expect(await searchMessagesAsync("hello")).toHaveLength(2);
});

it("interrupts pending scans before maintenance and reopens against the new data", async () => {
  const pending = expect(searchMessagesAsync("hello")).rejects.toMatchObject({ status: 503 });
  await closeMessageSearch();
  await pending;
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  insertMessage("replacement", { id: "m", at: 1, role: "user", kind: "text", text: "hello replacement" });
  expect(await searchMessagesAsync("hello")).toMatchObject([{ threadId: "replacement" }]);
});

it("opens read-only, fails safely, and never creates a missing database", async () => {
  const file = join(DATA_DIR, "missing.sqlite"), worker = new MessageSearchWorker(file);
  try {
    await expect(worker.search("private-query", 40)).rejects.toMatchObject({ message: "Search could not finish. Try again shortly.", status: 503 });
    expect(existsSync(file)).toBe(false);
  } finally { await worker.close(); }
});

it("bounds a stuck worker's lifetime and rejects all waiting requests", async () => {
  const worker = new MessageSearchWorker(join(DATA_DIR, "messages.db"), 1);
  try {
    const results = await Promise.allSettled([worker.search("hello", 40), worker.search("hello", 40)]);
    expect(results.every(result => result.status === "rejected" && result.reason.status === 503)).toBe(true);
  } finally { await worker.close(); }
});

it("answers session recall off the main thread with the same hits as the direct queries", async () => {
  insertMessage("a", { id: "m3", at: 5, role: "bot", kind: "text", text: "The booking dashboard is live", from: { name: "Scout" } } as never);
  indexMemoryFile("dog-1", "MEMORY.md", "Bookings close on Fridays", { mtimeMs: 7, bytes: 25 });
  for (const [query, range] of [["booking dashboard", undefined], ["needle", { since: 0 }], ["absent", undefined], ["dashboard", { since: 6 }]] as const) {
    expect(await recallMessagesOffThread(query, ["a", "b"], 5, range)).toEqual(recallMessages(query, ["a", "b"], 5, range));
  }
  expect(await recallMessagesOffThread("booking", [], 5)).toEqual([]);
  expect(await recentMessagesOffThread(["a", "b"], { since: 2 }, 5)).toEqual(recentMessages(["a", "b"], { since: 2 }, 5));
  expect(await recallMemoryOffThread("bookings fridays", ["dog-1", "dog-2"], 5)).toEqual([recallMemory("bookings fridays", "dog-1", 5), []]);
});

it("ends a read that runs past its budget with a narrower-search answer", async () => {
  const worker = new MessageSearchWorker(join(DATA_DIR, "messages.db"), 500);
  try {
    const endless = { sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE 1${WITHIN_BUDGET}) SELECT count(*) FROM n`, params: [] };
    await expect(worker.read([endless])).rejects.toMatchObject({ message: SEARCH_TOO_SLOW, status: 503 });
    expect(await worker.read([{ sql: "SELECT 1 AS one", params: [] }])).toEqual([[{ one: 1 }]]);
  } finally { await worker.close(); }
});
