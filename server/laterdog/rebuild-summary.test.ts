import { describe, expect, it } from "vitest";
import { DEFAULT_REBUILD_BYTES, MAX_SUMMARY_BYTES, selectReplay, type ReplayEntry } from "../context-rebuild.ts";
import { buildRecoveryText } from "../turn-context.ts";
import { droppedDigest, withDroppedSummary } from "./rebuild-summary.ts";

const longChat = (): ReplayEntry[] => {
  const history: ReplayEntry[] = [{ id: "m0", role: "user", text: "OLDEST_DECISION: deploy only to port 9001" }];
  for (let i = 1; i < 400; i++) history.push({ id: `m${i}`, role: i % 2 ? "assistant" : "user", text: `turn ${i} ${"work ".repeat(400)}` });
  return history;
};

const rebuild = (history: ReplayEntry[], engine?: { text: string; throughId: string; at: number }) => {
  const excludedIds = new Set<string>();
  const selection = selectReplay(history, { budgetBytes: DEFAULT_REBUILD_BYTES, excludedIds });
  const transcript = withDroppedSummary({ context: history, transcript: selection.transcript, representedIds: selection.representedIds, excludedIds, engine });
  return { selection, recovery: buildRecoveryText({ text: "which port?", transcript: transcript.map(({ role, text }) => ({ role, text })) })! };
};

describe("a rebuild that drops history carries a summary of what it dropped", () => {
  it("keeps the oldest decision of an 800 KB chat when the engine refuses its saved session", () => {
    const history = longChat();
    expect(history.reduce((n, entry) => n + entry.text.length, 0)).toBeGreaterThan(790_000);
    const { selection, recovery } = rebuild(history);
    expect(selection.dropped).toBeGreaterThan(300);
    expect(recovery).toContain("Earlier conversation summary");
    expect(recovery).toContain("OLDEST_DECISION: deploy only to port 9001");
    expect(Buffer.byteLength(recovery)).toBeLessThan(DEFAULT_REBUILD_BYTES + MAX_SUMMARY_BYTES + 1_024);
  });

  it("puts the engine's own compaction summary first and digests only what came after it", () => {
    const history = longChat();
    const { recovery } = rebuild(history, { text: "ENGINE_SUMMARY: port 9001 was chosen first.", throughId: "m300", at: 1 });
    expect(recovery).toContain("ENGINE_SUMMARY: port 9001 was chosen first.");
    expect(recovery).not.toContain("OLDEST_DECISION");
    expect(recovery).toContain("turn 302");
  });

  it("ignores an engine summary from a branch the chat no longer shows", () => {
    const { recovery } = rebuild(longChat(), { text: "ABANDONED_BRANCH summary", throughId: "gone", at: 1 });
    expect(recovery).not.toContain("ABANDONED_BRANCH");
    expect(recovery).toContain("OLDEST_DECISION");
  });

  it("changes nothing when the whole chat fits", () => {
    const history: ReplayEntry[] = [{ id: "a", role: "user", text: "hello" }, { id: "b", role: "assistant", text: "hi" }];
    const selection = selectReplay(history, {});
    expect(withDroppedSummary({ context: history, transcript: selection.transcript, representedIds: selection.representedIds, excludedIds: new Set() }))
      .toEqual(selection.transcript);
  });

  it("digests the oldest and newest of the person's messages within its budget", () => {
    const entries: ReplayEntry[] = Array.from({ length: 200 }, (_, i) => ({ id: `u${i}`, role: i % 2 ? "assistant" : "user", text: `message ${i} ${"x".repeat(500)}` }));
    const digest = droppedDigest(entries, 4_000);
    expect(Buffer.byteLength(digest)).toBeLessThanOrEqual(4_000);
    expect(digest).toContain("message 0 ");
    expect(digest).toContain("message 198 ");
    expect(digest).toMatch(/\[\d+ messages between these omitted\]/);
    expect(digest).not.toContain("message 1 ");
  });
});
