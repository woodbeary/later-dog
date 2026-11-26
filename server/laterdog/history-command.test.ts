import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { initializeHistoryShard } from "../../deploy/laterdog/home/src/history-schema.ts";
import { executeHistoryOperation, initializeHistoryMessageIndex } from "../../shared/history-message-operations.ts";
import { HISTORY_RECEIPT_PREFIX, receiptDigest } from "../../shared/history-receipt.ts";
import type { HistorySql } from "../../shared/history-values.ts";
import type { HistoryOperation } from "../../shared/history-shard-types.ts";
import { DATA_DIR } from "../config.ts";
import {
  appendMessage,
  closeMessageDb,
  initializeMessageDatabase,
  readCommandReceipt,
  recoverHistoryCommands,
  readThread,
  withCommandReceipt,
} from "../message-db.ts";
import type { Message } from "../store.ts";

const remote = vi.hoisted(() => {
  vi.resetModules();
  return {
    send: undefined as undefined | ((thread: string, op: HistoryOperation, id: string) => unknown),
    objects: new Map<string, string>(),
  };
});
vi.mock("./history-client.ts", async (load) => {
  const original = await load<typeof import("./history-client.ts")>();
  return {
    ...original,
    isRemoteHistory: () => true,
    remoteHistoryGeneration: () => "fixed",
    historyExecute: (thread: string, op: HistoryOperation, id: string) => remote.send!(thread, op, id),
    historyMany: (_threads: string[], op: HistoryOperation) => [
      { threadId: "thread", result: remote.send!("thread", op, "") },
    ],
    storeHistoryReceipt: (raw: string) => {
      const sha = createHash("sha256").update(raw).digest("hex");
      remote.objects.set(sha, raw);
      return HISTORY_RECEIPT_PREFIX + sha;
    },
    readHistoryReceipt: (ref: string) => {
      const raw = remote.objects.get(receiptDigest(ref));
      if (raw === undefined) throw Error("Missing receipt");
      return raw;
    },
  };
});
it("keeps the first accepted command and newer leaf across lost acknowledgment, stale control restore and generated ID changes", () => {
  const shard = new DatabaseSync(":memory:");
  const sql: HistorySql = {
    exec(query, ...args) {
      return shard.prepare(query).all(...args.map((a) => (a instanceof ArrayBuffer ? new Uint8Array(a) : a))) as never;
    },
  };
  initializeHistoryShard(sql);
  initializeHistoryMessageIndex(sql);
  let seq = 1,
    lose = false;
  const accepted = new Map<string, unknown>();
  remote.send = (thread, op, requestId) => {
    if (requestId && accepted.has(requestId)) return accepted.get(requestId);
    const result = executeHistoryOperation(sql, thread, op, () => String(seq++));
    if (requestId) accepted.set(requestId, result);
    if (lose && ["messages.command", "messages.append"].includes(op.op)) {
      lose = false;
      throw Error("lost acknowledgment");
    }
    return result;
  };
  const control = join(DATA_DIR, "history-control.db"),
    prior = join(DATA_DIR, "prior-control.db");
  mkdirSync(DATA_DIR, { recursive: true });
  const init = new DatabaseSync(control);
  initializeMessageDatabase(init);
  for (const table of ["history_control_generation", "history_receipt_generation"])
    init.exec(
      "CREATE TABLE " +
        table +
        "(singleton INTEGER PRIMARY KEY,generation TEXT NOT NULL); INSERT INTO " +
        table +
        " VALUES(1,'fixed')",
    );
  for (const position of ["-42", "9007199254741133", "9223372036854775807"]) {
    init
      .prepare("INSERT INTO command_receipts(rowid,kind,key,at,result) VALUES(CAST(? AS INTEGER),'unrelated',?,0,?)")
      .run(position, position, HISTORY_RECEIPT_PREFIX + "0".repeat(64));
  }
  init.close();
  copyFileSync(control, prior);
  const message = (id: string): Message => ({
    id,
    at: 1,
    role: "bot",
    kind: "text",
    text: "Private conversation output " + id,
  });
  const save = (id: string) =>
    withCommandReceipt(
      "digest.append",
      "stable",
      () => {
        const m = message(id);
        appendMessage("thread", m);
        return JSON.stringify(m);
      },
      1,
    );
  try {
    lose = true;
    expect(() => save("original")).toThrow("lost acknowledgment");
    expect(readCommandReceipt("digest.append", "stable")?.result).toBe(JSON.stringify(message("original")));
    appendMessage("thread", message("newer"));
    closeMessageDb();
    copyFileSync(prior, control);
    recoverHistoryCommands();
    expect(readCommandReceipt("digest.append", "stable")?.result).toBe(JSON.stringify(message("original")));
    const restored = new DatabaseSync(control, { readOnly: true });
    const source = shard.prepare("SELECT position FROM history_command_journal").get()!.position;
    expect(
      restored.prepare("SELECT CAST(rowid AS TEXT) rid FROM command_receipts WHERE kind='digest.append'").get()?.rid,
    ).toBe(source);
    expect(
      restored
        .prepare("SELECT CAST(rowid AS TEXT) rid FROM command_receipts WHERE kind='unrelated' ORDER BY rowid")
        .all()
        .map((row) => row.rid),
    ).toEqual(["-42", "9007199254741133", "9223372036854775807"]);
    restored.close();
    expect(save("regenerated")).toEqual({ result: JSON.stringify(message("original")), replayed: true });
    expect(readThread("thread", "/missing")).toMatchObject({
      activeLeafId: "newer",
      messages: [{ id: "original" }, { id: "newer" }],
    });
    lose = true;
    expect(() => appendMessage("thread", message("unconfirmed"))).toThrow("lost acknowledgment");
    expect(existsSync(join(DATA_DIR, "history-pending.json"))).toBe(true);
    expect(readThread("thread", "/missing").messages.map((m) => m.id)).toEqual(["original", "newer", "unconfirmed"]);
    expect(existsSync(join(DATA_DIR, "history-pending.json"))).toBe(false);
    closeMessageDb();
    expect(readFileSync(control).includes(Buffer.from("Private conversation output"))).toBe(false);
    const check = new DatabaseSync(control, { readOnly: true });
    try {
      expect(check.prepare("SELECT result FROM command_receipts WHERE kind='digest.append'").get()?.result).toBe(
        HISTORY_RECEIPT_PREFIX +
          createHash("sha256")
            .update(JSON.stringify(message("original")))
            .digest("hex"),
      );
      expect(check.prepare("SELECT count(*) n FROM history_outbox").get()?.n).toBe(0);
    } finally {
      check.close();
    }
  } finally {
    closeMessageDb();
    shard.close();
    rmSync(prior, { force: true });
    rmSync(control, { force: true });
  }
});
