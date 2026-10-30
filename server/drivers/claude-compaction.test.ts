import { describe, expect, it } from "vitest";

import { claudeCompactionEvent } from "./claude.ts";

const status = (fields: Record<string, unknown>) => ({ type: "system", subtype: "status", ...fields });
const boundary = (metadata?: Record<string, unknown>) => ({
  type: "system",
  subtype: "compact_boundary",
  ...(metadata ? { compact_metadata: metadata } : {}),
});

describe("reading the engine's own compaction from its stream", () => {
  it("starts when the engine says it is compacting", () => {
    expect(claudeCompactionEvent(status({ status: "compacting" }))).toEqual({ type: "session.compacting" });
  });

  it("ends with the outcome the engine reports", () => {
    expect(claudeCompactionEvent(status({ status: null, compact_result: "success" }))).toEqual({ type: "session.compacted", ok: true });
    expect(claudeCompactionEvent(status({ status: null, compact_result: "failed", compact_error: "  Conversation too long.  " })))
      .toEqual({ type: "session.compacted", ok: false, error: "Conversation too long." });
    expect(claudeCompactionEvent(status({ status: null, compact_result: "failed", compact_error: 42 })))
      .toEqual({ type: "session.compacted", ok: false });
    expect(claudeCompactionEvent(status({ status: null }))).toEqual({ type: "session.compacted", ok: true, skipped: true });
  });

  it("reads the trigger and the size before and after from the boundary", () => {
    expect(claudeCompactionEvent(boundary({ trigger: "manual", pre_tokens: 182_345.4, post_tokens: 24_100 })))
      .toEqual({ type: "session.compacted", ok: true, trigger: "manual", preTokens: 182_345, postTokens: 24_100 });
    expect(claudeCompactionEvent(boundary({ trigger: "auto", pre_tokens: 90_000 })))
      .toEqual({ type: "session.compacted", ok: true, trigger: "auto", preTokens: 90_000 });
    expect(claudeCompactionEvent(boundary({ trigger: "sideways", pre_tokens: -1, post_tokens: "many" })))
      .toEqual({ type: "session.compacted", ok: true });
    expect(claudeCompactionEvent(boundary({ pre_tokens: Number.POSITIVE_INFINITY })))
      .toEqual({ type: "session.compacted", ok: true });
    expect(claudeCompactionEvent(boundary())).toEqual({ type: "session.compacted", ok: true });
  });

  it("ignores other statuses, permission changes and a helper's own compaction", () => {
    expect(claudeCompactionEvent(status({ status: "requesting" }))).toBeNull();
    expect(claudeCompactionEvent(status({ status: null, permissionMode: "acceptEdits" }))).toBeNull();
    expect(claudeCompactionEvent({ ...status({ status: "compacting" }), parent_tool_use_id: "toolu_1" })).toBeNull();
    expect(claudeCompactionEvent({ ...boundary({ trigger: "auto" }), parent_tool_use_id: "toolu_1" })).toBeNull();
    expect(claudeCompactionEvent({ type: "system", subtype: "init" })).toBeNull();
    expect(claudeCompactionEvent({ type: "assistant", message: { content: [] } })).toBeNull();
    expect(claudeCompactionEvent(null)).toBeNull();
  });
});
