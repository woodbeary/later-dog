import { describe, expect, it } from "vitest";
import { codexCompactionEvent, harnessCompacts, rebuildNeedsSummary } from "./native-compaction.ts";

describe("harness compaction", () => {
  it("is on for Claude Code and Codex unless the server setting turns it off", () => {
    expect(harnessCompacts("claudeAgent", undefined)).toBe(true);
    expect(harnessCompacts("codex", {})).toBe(true);
    expect(harnessCompacts("codex", { harnessCompaction: true })).toBe(true);
    expect(harnessCompacts("claudeAgent", { harnessCompaction: false })).toBe(false);
    expect(harnessCompacts("codex", { harnessCompaction: false })).toBe(false);
  });

  it("keeps later.dog's own compactor for engines that have none", () => {
    for (const kind of ["pi", "acp", "openai-compat", "cerebras", "grok"]) expect(harnessCompacts(kind, undefined)).toBe(false);
  });

  it("summarises only when a session starts fresh and the replay cannot hold the whole chat", () => {
    expect(rebuildNeedsSummary({ startsFresh: true, droppedFromReplay: 3 })).toBe(true);
    expect(rebuildNeedsSummary({ startsFresh: true, droppedFromReplay: 0 })).toBe(false);
    expect(rebuildNeedsSummary({ startsFresh: false, droppedFromReplay: 3 })).toBe(false);
  });

  it("turns a Codex context compaction item into the compacting status line", () => {
    expect(codexCompactionEvent("started", { type: "contextCompaction" })).toEqual({ type: "session.compacting" });
    expect(codexCompactionEvent("completed", { type: "contextCompaction" })).toEqual({ type: "session.compacted", ok: true, trigger: "auto" });
    expect(codexCompactionEvent("completed", { type: "agentMessage" })).toBeNull();
    expect(codexCompactionEvent("started", undefined)).toBeNull();
  });
});
