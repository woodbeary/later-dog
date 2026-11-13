import { describe, expect, it } from "vitest";
import { recallsThisTurn } from "./session-start-recall.ts";

describe("automatic recall", () => {
  it("runs when Claude Code or Codex starts or rebuilds a session, and leaves resumed turns to the search tool", () => {
    for (const kind of ["claudeAgent", "codex"]) {
      expect(recallsThisTurn({}, kind)).toBe(true);
      expect(recallsThisTurn({ resumeCursor: undefined }, kind)).toBe(true);
      expect(recallsThisTurn({ resumeCursor: "session-1" }, kind)).toBe(false);
    }
  });

  it("keeps running on every turn for engines that replay the chat themselves", () => {
    for (const kind of ["openai-compat", "pi", "acp"]) expect(recallsThisTurn({ resumeCursor: "session-1" }, kind)).toBe(true);
  });
});
