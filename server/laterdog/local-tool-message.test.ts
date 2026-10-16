import { describe, expect, it } from "vitest";
import { EDIT_REFUSAL } from "./local-tool-message.ts";

describe("a local tool on the owner's Mac", () => {
  it("edits only the messages it sent, and says so in plain words that never say user", () => {
    expect(EDIT_REFUSAL).toBe("A local tool can only edit messages that a local tool sent. Your own messages are yours to edit in the desktop app.");
    expect(EDIT_REFUSAL).not.toMatch(/\buser\b/i);
  });
});
