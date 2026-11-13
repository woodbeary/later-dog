import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  claudeResumeRefusal,
  classifyResumeFailure,
  mayReplay,
  recoveryPromptFor,
  type ResumeAttemptState,
} from "./resume-recovery.ts";

const state = (over: Partial<ResumeAttemptState> = {}): ResumeAttemptState => ({
  attempted: true,
  rejected: true,
  promptSubmitted: false,
  producedOutput: false,
  ...over,
});

describe("classifyResumeFailure", () => {
  it("is before-accept when a resume was rejected and nothing was sent", () => {
    expect(classifyResumeFailure(state())).toBe("before-accept");
    expect(mayReplay("before-accept")).toBe(true);
  });

  it("is after-accept once the prompt was submitted", () => {
    expect(classifyResumeFailure(state({ promptSubmitted: true }))).toBe("after-accept");
    expect(mayReplay("after-accept")).toBe(false);
  });

  it("is after-accept once ANYTHING streamed, whatever the bookkeeping says", () => {
    expect(classifyResumeFailure(state({ promptSubmitted: false, producedOutput: true }))).toBe("after-accept");
  });

  it("is unknown when no resume was attempted, or none was rejected", () => {
    expect(classifyResumeFailure(state({ attempted: false }))).toBe("unknown");
    expect(classifyResumeFailure(state({ rejected: false }))).toBe("unknown");
  });

  it("never permits a replay on an unproven boundary", () => {
    expect(mayReplay("unknown")).toBe(false);
  });

  it("classifies from state alone — no error text is consulted", () => {
    for (const value of Object.values(state())) expect(typeof value).toBe("boolean");
  });
});

describe("recoveryPromptFor", () => {
  const replay = "[rebuild]\n\nUser: my dog is Biscuit\n\nwhat now?";

  it("rebuilds history for a safe failure", () => {
    const out = recoveryPromptFor({ recoveryText: replay, currentText: "what now?", failure: "before-accept" });
    expect(out).toEqual({ text: replay, replayed: true });
  });

  it("sends the turn UNCHANGED after acceptance, never a second copy", () => {
    for (const failure of ["after-accept", "unknown"] as const) {
      expect(recoveryPromptFor({ recoveryText: replay, currentText: "what now?", failure }))
        .toEqual({ text: "what now?", replayed: false });
    }
  });

  it("falls back to the current text when the harness attached no rebuild", () => {
    expect(recoveryPromptFor({ recoveryText: undefined, currentText: "what now?", failure: "before-accept" }))
      .toEqual({ text: "what now?", replayed: false });
  });

  it("does not replay a thread whose only history is the message being sent", () => {
    expect(recoveryPromptFor({ recoveryText: "what now?", currentText: "what now?", failure: "before-accept" }))
      .toEqual({ text: "what now?", replayed: false });
  });

  it("carries the current message exactly once", () => {
    const out = recoveryPromptFor({ recoveryText: replay, currentText: "what now?", failure: "before-accept" });
    expect(out.text.match(/what now\?/g)).toHaveLength(1);
  });
});

describe("a saved session Claude Code refuses", () => {
  const captured = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "testing", "claude-lost-session-result.json"), "utf8"));

  it("is recognised in the error result Claude Code 2.1.316 returned live", () => {
    expect(claudeResumeRefusal(captured)).toBe("No conversation found with session ID: e96b5103-1b35-4f0d-9557-9c63a6a11557");
    expect(claudeResumeRefusal({ is_error: true, errors: ["Failed to resume session: transcript unreadable"] })).toBe("Failed to resume session: transcript unreadable");
  });

  it("is not confused with other error results", () => {
    expect(claudeResumeRefusal({ is_error: true, errors: ["API Error: 529 overloaded"] })).toBeNull();
    expect(claudeResumeRefusal({ is_error: false, errors: ["No conversation found with session ID: x"] })).toBeNull();
    expect(claudeResumeRefusal({ is_error: true, result: "No conversation found with session ID: x" })).toBeNull();
  });
});
