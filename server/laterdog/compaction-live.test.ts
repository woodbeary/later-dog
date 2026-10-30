import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WireMessage } from "../../shared/wire.ts";
import {
  COMPACTING_LINE,
  compactionTool,
  createCompactionLive,
  fileCompactionLedger,
  type CompactionHost,
  type OpenCompaction,
} from "./compaction-live.ts";

const THREAD = "t1";

function fixture(overrides: Partial<CompactionHost> = {}, leftOpen: OpenCompaction[] = []) {
  let clock = 1_000_000;
  let nextId = 0;
  const threads = new Map<string, WireMessage[]>();
  const rows = (threadId = THREAD) => threads.get(threadId) ?? [];
  const patches: Array<{ threadId: string; messageId: string; tool: WireMessage["tool"] }> = [];
  const changes: string[] = [];
  let ledger = leftOpen;
  const live = createCompactionLive({
    append: (threadId, message) => {
      const row = { ...message, id: `m${++nextId}`, at: clock } as WireMessage;
      threads.set(threadId, [...rows(threadId), row]);
      return row;
    },
    patch: (threadId, messageId, patch) => {
      patches.push({ threadId, messageId, tool: patch.tool });
      threads.set(threadId, rows(threadId).map((row) => (row.id === messageId ? { ...row, ...patch } : row)));
    },
    ledger: { read: () => ledger, write: (open) => { ledger = open; } },
    changed: (threadId) => { changes.push(threadId); },
    now: () => clock,
    ...overrides,
  });
  return {
    live,
    rows,
    patches,
    changes,
    tool: (threadId = THREAD) => rows(threadId).at(-1)?.tool,
    advance: (ms: number) => { clock += ms; },
    ledger: () => ledger,
  };
}

describe("the engine's own compaction, live in the chat", () => {
  it("shows one row while the engine compacts and closes it with how long it took and how much it saved", () => {
    const f = fixture();
    f.live.started(THREAD, { turnId: "turn-1", stream: true });
    expect(f.rows()).toEqual([expect.objectContaining({
      role: "bot", kind: "activity", turnId: "turn-1",
      tool: { name: "context compaction (auto)", spoken: COMPACTING_LINE, compaction: true },
    })]);
    expect(f.live.current(THREAD)).toBe(COMPACTING_LINE);
    expect(f.ledger()).toEqual([{ threadId: THREAD, messageId: "m1" }]);

    f.advance(42_000);
    f.live.finished(THREAD, { ok: true, turnId: "turn-1", stream: true });
    f.live.finished(THREAD, { ok: true, trigger: "auto", preTokens: 182_345, postTokens: 1, turnId: "turn-1", stream: true });

    expect(f.rows()).toHaveLength(1);
    expect(f.tool()).toEqual({
      name: "context compaction (auto)",
      ok: true,
      compaction: true,
      spoken: "Compacted the conversation in 42 seconds",
      summary: "Compacted the conversation in 42 seconds",
      output: "Before: 182,345 tokens\nAfter: 1 token",
    });
    expect(f.live.current(THREAD)).toBeUndefined();
    expect(f.ledger()).toEqual([]);
    expect(f.changes).toEqual([THREAD, THREAD]);
  });

  it("treats the engine's repeated compacting heartbeats as the same compaction", () => {
    const f = fixture();
    f.live.started(THREAD, { turnId: "turn-1", stream: true });
    f.advance(30_000);
    f.live.started(THREAD, { turnId: "turn-1", stream: true });
    f.advance(30_000);
    f.live.started(THREAD, { turnId: "turn-1", stream: true });
    expect(f.rows()).toHaveLength(1);
    expect(f.patches).toEqual([]);
    f.advance(30_000);
    f.live.finished(THREAD, { ok: true, turnId: "turn-1", stream: true });
    expect(f.tool()?.spoken).toBe("Compacted the conversation in 2 minutes");
  });

  it("folds the engine's hooks and its stream into one row, whichever arrives first", () => {
    const hooksFirst = fixture();
    hooksFirst.live.started(THREAD, { turnId: "turn-1", trigger: "manual" });
    hooksFirst.live.started(THREAD, { turnId: "turn-1", stream: true });
    hooksFirst.live.finished(THREAD, { ok: true, digests: 2, turnId: "turn-1" });
    hooksFirst.live.finished(THREAD, { ok: true, turnId: "turn-1", stream: true });
    hooksFirst.live.finished(THREAD, { ok: true, trigger: "manual", preTokens: 90_000, postTokens: 12_000, turnId: "turn-1", stream: true });
    expect(hooksFirst.rows()).toHaveLength(1);
    expect(hooksFirst.tool()).toMatchObject({
      name: "context compaction (manual)",
      ok: true,
      output: "Before: 90,000 tokens\nAfter: 12,000 tokens\nRe-sent the last 2 digests",
    });

    const streamFirst = fixture();
    streamFirst.live.started(THREAD, { turnId: "turn-1", stream: true });
    streamFirst.live.started(THREAD, { turnId: "turn-1", trigger: "manual" });
    expect(streamFirst.tool()?.name).toBe("context compaction (manual)");
    expect(streamFirst.ledger()).toEqual([{ threadId: THREAD, messageId: "m1", trigger: "manual" }]);
    streamFirst.live.finished(THREAD, { ok: true, turnId: "turn-1", stream: true });
    streamFirst.live.finished(THREAD, { ok: true, digests: 1, turnId: "turn-1" });
    expect(streamFirst.rows()).toHaveLength(1);
    expect(streamFirst.tool()).toMatchObject({ name: "context compaction (manual)", ok: true, output: "Re-sent the last 1 digest" });
  });

  it("never lets a later report hide a failed compaction", () => {
    const f = fixture();
    f.live.started(THREAD, { turnId: "turn-1", stream: true });
    f.live.finished(THREAD, {
      ok: false,
      error: "  Conversation too long.\n  Press esc twice to go up a few messages.  ",
      turnId: "turn-1",
      stream: true,
    });
    f.live.finished(THREAD, { ok: true, preTokens: 200_000, turnId: "turn-1", stream: true });
    expect(f.tool()).toEqual({
      name: "context compaction (auto)",
      ok: false,
      compaction: true,
      spoken: "Couldn't compact the conversation",
      summary: "Couldn't compact the conversation",
      output: "Conversation too long. Press esc twice to go up a few messages.\nBefore: 200,000 tokens",
    });
  });

  it("turns a compaction that looked done into a failure when the engine reports one", () => {
    const f = fixture();
    f.live.started(THREAD, { turnId: "turn-1" });
    f.live.finished(THREAD, { ok: true, digests: 1, turnId: "turn-1" });
    f.live.finished(THREAD, { ok: false, error: "Compaction interrupted", turnId: "turn-1", stream: true });
    expect(f.rows()).toHaveLength(1);
    expect(f.tool()).toMatchObject({
      ok: false,
      spoken: "Couldn't compact the conversation",
      output: "Compaction interrupted\nRe-sent the last 1 digest",
    });
  });

  it("adds a row for a failure even when the start was never seen", () => {
    const f = fixture();
    f.live.finished(THREAD, { ok: false, error: "Not enough messages to compact.", turnId: "turn-1", stream: true });
    expect(f.rows()).toEqual([expect.objectContaining({
      turnId: "turn-1",
      tool: expect.objectContaining({ ok: false, spoken: "Couldn't compact the conversation", output: "Not enough messages to compact." }),
    })]);
    expect(f.live.current(THREAD)).toBeUndefined();
    expect(f.ledger()).toEqual([]);
  });

  it("keeps a secret out of the error and cuts a long one short", () => {
    const f = fixture();
    f.live.finished(THREAD, { ok: false, error: `AKIAABCDEFGHIJKLMNOP ${"x".repeat(5_000)}`, turnId: "turn-1" });
    const output = f.tool()!.output!;
    expect(output).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(output.startsWith("«redacted 20 chars» xxx")).toBe(true);
    expect(output).toHaveLength(2_001);
    expect(output.endsWith("…")).toBe(true);
  });

  it("stays quiet about a skipped compaction and keeps the row it already showed", () => {
    const quiet = fixture();
    quiet.live.finished(THREAD, { ok: true, skipped: true, turnId: "turn-1", stream: true });
    expect(quiet.rows()).toEqual([]);

    const shown = fixture();
    shown.live.started(THREAD, { turnId: "turn-1", stream: true });
    shown.live.finished(THREAD, { ok: true, skipped: true, turnId: "turn-1", stream: true });
    expect(shown.tool()).toMatchObject({ ok: true, spoken: "Skipped compacting the conversation" });
    shown.live.finished(THREAD, { ok: true, preTokens: 150_000, postTokens: 20_000, turnId: "turn-1", stream: true });
    expect(shown.rows()).toHaveLength(1);
    expect(shown.tool()).toMatchObject({
      ok: true,
      spoken: "Compacted the conversation in under a second",
      output: "Before: 150,000 tokens\nAfter: 20,000 tokens",
    });
  });

  it("starts a new row for a second compaction in the same turn", () => {
    const f = fixture();
    f.live.started(THREAD, { turnId: "turn-1", stream: true });
    f.live.finished(THREAD, { ok: true, turnId: "turn-1", stream: true });
    f.live.started(THREAD, { turnId: "turn-1", stream: true });
    expect(f.rows().map((row) => row.tool?.spoken)).toEqual(["Compacted the conversation in under a second", COMPACTING_LINE]);
    expect(f.live.current(THREAD)).toBe(COMPACTING_LINE);
  });

  it("stops the open row when the turn ends or the engine exits, and starts fresh after", () => {
    const f = fixture();
    f.live.started(THREAD, { turnId: "turn-1", stream: true });
    f.advance(5_000);
    f.live.settle(THREAD);
    expect(f.tool()).toEqual({
      name: "context compaction (auto)",
      ok: false,
      compaction: true,
      spoken: "Stopped compacting the conversation",
      summary: "Stopped compacting the conversation",
    });
    expect(f.live.current(THREAD)).toBeUndefined();
    expect(f.ledger()).toEqual([]);
    f.live.settle(THREAD);
    expect(f.rows()).toHaveLength(1);
    f.live.started(THREAD, { turnId: "turn-2", stream: true });
    expect(f.rows()).toHaveLength(2);
    expect(f.rows()[1]).toMatchObject({ turnId: "turn-2", tool: { spoken: COMPACTING_LINE } });
  });

  it("keeps each thread's compaction to itself", () => {
    const f = fixture();
    f.live.started("t1", { turnId: "a", stream: true });
    f.live.started("t2", { turnId: "b", stream: true });
    f.live.finished("t1", { ok: true, turnId: "a", stream: true });
    expect(f.live.current("t1")).toBeUndefined();
    expect(f.live.current("t2")).toBe(COMPACTING_LINE);
    expect(f.ledger()).toEqual([{ threadId: "t2", messageId: "m2" }]);
    f.live.started("t2", { turnId: "b", stream: true });
    expect(f.rows("t2")).toHaveLength(1);
  });

  it("closes the rows a restart left open", () => {
    const f = fixture({}, [{ threadId: "t1", messageId: "m7", trigger: "manual" }, { threadId: "t2", messageId: "m9" }]);
    expect(f.live.foldLeftovers()).toBe(2);
    expect(f.patches).toEqual([
      { threadId: "t1", messageId: "m7", tool: compactionTool({ status: "stopped", trigger: "manual" }) },
      { threadId: "t2", messageId: "m9", tool: compactionTool({ status: "stopped" }) },
    ]);
    expect(f.patches[0]!.tool).toMatchObject({ name: "context compaction (manual)", ok: false, spoken: "Stopped compacting the conversation" });
    expect(f.ledger()).toEqual([]);
    expect(f.live.foldLeftovers()).toBe(0);
  });

  it("keeps going when the transcript, the ledger or the broadcast fails", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const refused = fixture({ append: () => null });
      refused.live.started(THREAD, { turnId: "turn-1", stream: true });
      expect(refused.live.current(THREAD)).toBeUndefined();
      expect(refused.changes).toEqual([]);
      refused.live.finished(THREAD, { ok: true, turnId: "turn-1", stream: true });

      const broken = fixture({
        patch: () => { throw new Error("disk full"); },
        ledger: {
          read: () => { throw new Error("unreadable"); },
          write: () => { throw new Error("read-only"); },
        },
        changed: () => { throw new Error("socket closed"); },
      });
      broken.live.started(THREAD, { turnId: "turn-1", stream: true });
      expect(broken.live.current(THREAD)).toBe(COMPACTING_LINE);
      broken.live.finished(THREAD, { ok: true, turnId: "turn-1", stream: true });
      expect(broken.live.current(THREAD)).toBeUndefined();
      expect(broken.live.foldLeftovers()).toBe(0);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

describe("the open compactions on disk", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("round-trips the open rows privately and skips anything malformed", () => {
    dir = mkdtempSync(join(tmpdir(), "laterdog-compactions-"));
    const file = join(dir, "compactions-open.json");
    const ledger = fileCompactionLedger(file);
    expect(ledger.read()).toEqual([]);

    ledger.write([{ threadId: "t1", messageId: "m1", trigger: "manual" }]);
    expect(ledger.read()).toEqual([{ threadId: "t1", messageId: "m1", trigger: "manual" }]);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    writeFileSync(file, JSON.stringify([
      { threadId: "t1", messageId: "m1" },
      { threadId: "t2" },
      { threadId: "t3", messageId: "m3", trigger: "sideways" },
      null,
      "t4",
    ]));
    expect(ledger.read()).toEqual([{ threadId: "t1", messageId: "m1" }]);
    writeFileSync(file, JSON.stringify({ threadId: "t1", messageId: "m1" }));
    expect(ledger.read()).toEqual([]);
    writeFileSync(file, "{not json");
    expect(ledger.read()).toEqual([]);
  });

  it("closes a compaction that was open when later.dog stopped", () => {
    dir = mkdtempSync(join(tmpdir(), "laterdog-compactions-"));
    const file = join(dir, "compactions-open.json");
    const before = fixture({ ledger: fileCompactionLedger(file) });
    before.live.started(THREAD, { turnId: "turn-1", stream: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ threadId: THREAD, messageId: "m1" }]);

    const after = fixture({ ledger: fileCompactionLedger(file) });
    expect(after.live.foldLeftovers()).toBe(1);
    expect(after.patches).toEqual([{ threadId: THREAD, messageId: "m1", tool: compactionTool({ status: "stopped" }) }]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  });
});
