import { describe, expect, it } from "vitest";

import { claudeForkArgs, claudeForksAtPoint } from "./claude.ts";
import { codexForkEndsAt } from "./codex.ts";

describe("Claude fork at a point", () => {
  it("is used only on a Claude Code known to be 2.1.316 or newer", () => {
    expect(claudeForksAtPoint([2, 1, 316])).toBe(true);
    expect(claudeForksAtPoint([2, 2, 0])).toBe(true);
    expect(claudeForksAtPoint([2, 1, 315])).toBe(false);
    expect(claudeForksAtPoint(null)).toBe(false);
  });

  it("resumes the kept session as a new session that stops at the kept entry", () => {
    expect(claudeForkArgs({ session: "kept-session", at: "kept-entry" }, "new-session")).toEqual([
      "--resume",
      "kept-session",
      "--fork-session",
      "--session-id",
      "new-session",
      "--resume-session-at",
      "kept-entry",
    ]);
  });
});

describe("Codex fork through a turn", () => {
  it("is trusted only when the forked thread ends at the asked turn", () => {
    const thread = (turns: string[]) => ({
      thread: { id: "fork", turns: turns.map((id) => ({ id })) },
    });
    expect(codexForkEndsAt(thread(["t1", "t2"]), "t2")).toBe(true);
    expect(codexForkEndsAt(thread(["t1", "t2", "t3"]), "t2")).toBe(false);
    expect(codexForkEndsAt(thread([]), "t2")).toBe(false);
    expect(codexForkEndsAt({ thread: { id: "fork" } }, "t2")).toBe(false);
    expect(codexForkEndsAt({}, "t2")).toBe(false);
    expect(codexForkEndsAt(null, "t2")).toBe(false);
  });
});
