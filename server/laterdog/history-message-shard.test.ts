import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { initializeHistoryShard } from "../../deploy/laterdog/home/src/history-schema.ts";
import {
  executeHistoryOperation,
  initializeHistoryMessageIndex,
  storeHistoryMessageValues,
} from "../../shared/history-message-operations.ts";
import { readHistoryValue, type HistorySql } from "../../shared/history-values.ts";
import type { HistoryOperation } from "../../shared/history-shard-types.ts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql: HistorySql = {
    exec(query, ...args) {
      return db.prepare(query).all(...args.map((a) => (a instanceof ArrayBuffer ? new Uint8Array(a) : a))) as never;
    },
  };
  initializeHistoryShard(sql);
  initializeHistoryMessageIndex(sql);
  let n = 2 ** 40;
  return { db, sql, run: (op: HistoryOperation) => executeHistoryOperation(sql, "thread", op, () => String(++n)) };
}
const message = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  text,
  at: 4,
  role: "user",
  kind: "text",
  ...extra,
});
describe("sharded conversation operations", () => {
  it("keeps the first row order, follows the chosen branch and serializes conditional imports", () => {
    const { db, run } = fixture();
    const first = message("a", "start");
    run({ op: "messages.import", messages: [first], leaf: "a" });
    run({ op: "messages.append", message: message("b", "left", { parentId: "a" }) });
    run({ op: "messages.append", message: message("c", "right", { parentId: "a" }) });
    run({ op: "messages.update", message: message("b", "edited", { parentId: "a" }) });
    run({ op: "messages.update", message: message("absent", "lost") });
    run({ op: "messages.leaf", leaf: "b" });
    expect(run({ op: "messages.page", backward: true, limit: 2 })).toMatchObject({
      messages: [{ id: "c" }, { id: "b", text: "edited" }],
      hasMore: true,
      activeLeafId: "b",
    });
    expect(() => run({ op: "messages.import", messages: [], leaf: null })).toThrow("existing conversation");
    run({ op: "messages.delete" });
    expect(run({ op: "messages.page" })).toEqual({ messages: [], activeLeafId: null, hasMore: false, next: null });
    db.close();
  });
  it("returns the original command after recovery with an older coordinator and a new generated message ID", () => {
    const { db, run } = fixture(),
      key = "a".repeat(64);
    const first = message("original", "accepted");
    expect(
      run({
        op: "messages.command",
        key,
        result: JSON.stringify(first),
        operations: [{ op: "messages.append", message: first }],
      }),
    ).toBe(JSON.stringify(first));
    run({ op: "messages.append", message: message("newer", "after") });
    const replacement = message("regenerated", "accepted");
    const recovered = run({
      op: "messages.command",
      key,
      result: JSON.stringify(replacement),
      operations: [{ op: "messages.append", message: replacement }],
    });
    expect(recovered).toBe(JSON.stringify(first));
    expect(run({ op: "messages.page" })).toMatchObject({
      messages: [{ id: "original" }, { id: "newer" }],
      activeLeafId: "newer",
    });
    db.close();
  });
  it("finds both ends of an oversized Unicode message, verifies its exact raw JSON and can later make it small", () => {
    const { db, sql, run } = fixture();
    const body = "anchor " + "quoted 🐕 🦮 漢字 ".repeat(100000) + " finalneedle";
    const full = message("large", body, { requestPending: true, attachment: "héllo".repeat(200000) });
    run({ op: "messages.append", message: full });
    expect(run({ op: "messages.pending" })).toBe(true);
    expect(run({ op: "messages.search", query: " finalneedle", limit: 1 })).toMatchObject([
      { messageId: "large", snippet: expect.stringContaining("finalneedle") },
    ]);
    expect(run({ op: "messages.references", fragment: "héllohéllohéllo" })).toBe(true);
    expect(
      run({ op: "messages.recall", match: '"anchor" "finalneedle"', terms: ['"anchor"', '"finalneedle"'], limit: 5 }),
    ).toMatchObject([{ id: "large" }]);
    expect(run({ op: "messages.text", id: "large" })).toMatchObject({ text: body });
    expect(run({ op: "messages.page" })).toMatchObject({ messages: [full] });
    const rid = String(db.prepare("SELECT rowid FROM messages").get()!.rowid);
    expect(readHistoryValue(sql, "messages", rid, "json", "")).toBe(JSON.stringify(full));
    expect(db.prepare("SELECT max(length(bytes)) size FROM history_values").get()!.size).toBeLessThanOrEqual(
      384 * 1024,
    );
    const raw = ' { "payload":' + JSON.stringify("other".repeat(100000)) + " } ";
    const row = storeHistoryMessageValues(sql, ["15", "thread", "m", "5", "user", "text", null, raw]);
    expect(readHistoryValue(sql, "messages", "15", "json", String(row[7]))).toBe(raw);
    run({ op: "messages.update", message: message("large", "short") });
    expect(run({ op: "messages.search", query: "finalneedle" })).toEqual([]);
    expect(run({ op: "messages.recall", match: '"finalneedle"', terms: ['"finalneedle"'] })).toEqual([]);
    expect(db.prepare("SELECT count(*) n FROM history_values WHERE entry=?").get(rid)!.n).toBe(0);
    db.close();
  });
});
