import { describe, expect, it } from "vitest";
import { claudeCompactionSwitchedOff, codexCompactionEvent, engineWillCompact, harnessCompacts, rebuildNeedsSummary } from "./native-compaction.ts";

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

  it("leaves the chat to the engine only when the engine gives every sign it will compact it", () => {
    expect(engineWillCompact({ driverKind: "claudeAgent", modelKnown: false })).toBe(true);
    expect(engineWillCompact({ driverKind: "codex", modelKnown: true, signs: { managed: false } })).toBe(true);
    expect(engineWillCompact({ driverKind: "codex", modelKnown: false })).toBe(false);
    expect(engineWillCompact({ driverKind: "codex", modelKnown: true, signs: { managed: true } })).toBe(false);
    expect(engineWillCompact({ driverKind: "claudeAgent", modelKnown: true, signs: { switchedOff: true } })).toBe(false);
    expect(engineWillCompact({ driverKind: "claudeAgent", modelKnown: true, setting: { harnessCompaction: false } })).toBe(false);
    expect(engineWillCompact({ driverKind: "pi", modelKnown: true })).toBe(false);
  });

  it("keeps later.dog's fold for a model on this machine, an injected model, or a window under 100K", () => {
    expect(engineWillCompact({ driverKind: "claudeAgent", modelKnown: true, injectedModel: true })).toBe(false);
    expect(engineWillCompact({ driverKind: "claudeAgent", modelKnown: true, signs: { customEndpoint: true } })).toBe(false);
    expect(engineWillCompact({ driverKind: "claudeAgent", modelKnown: true, window: 32_000 })).toBe(false);
    expect(engineWillCompact({ driverKind: "claudeAgent", modelKnown: true, window: 99_999 })).toBe(false);
    expect(engineWillCompact({ driverKind: "claudeAgent", modelKnown: true, window: 100_000 })).toBe(true);
    expect(engineWillCompact({ driverKind: "codex", modelKnown: true, window: 32_000 })).toBe(false);
  });

  it("sees Claude Code's compaction switched off by its environment or by inherited settings", () => {
    expect(claudeCompactionSwitchedOff({})).toBe(false);
    expect(claudeCompactionSwitchedOff({ DISABLE_AUTO_COMPACT: "1" })).toBe(true);
    expect(claudeCompactionSwitchedOff({ DISABLE_COMPACT: "true" })).toBe(true);
    expect(claudeCompactionSwitchedOff({ DISABLE_AUTO_COMPACT: "0" })).toBe(false);
    expect(claudeCompactionSwitchedOff({}, { autoCompactEnabled: false })).toBe(true);
    expect(claudeCompactionSwitchedOff({}, { autoCompactEnabled: true })).toBe(false);
    expect(claudeCompactionSwitchedOff({}, { env: { DISABLE_AUTO_COMPACT: "1" } })).toBe(true);
  });
});
