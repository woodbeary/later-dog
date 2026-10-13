import { describe, expect, it } from "vitest";

import { QUIET_WORK_PROMPT, STEP_UPDATES_PROMPT, quietWorkEnvironment, workUpdatesPrompt } from "./work-updates.ts";

describe("how a dog keeps the person posted", () => {
  it("works quietly unless the person asked for step-by-step updates", () => {
    expect(workUpdatesPrompt(false)).toBe(QUIET_WORK_PROMPT);
    expect(QUIET_WORK_PROMPT).toMatch(/do not narrate your steps/);
    expect(QUIET_WORK_PROMPT).toMatch(/Finish with one clear answer/);
    expect(QUIET_WORK_PROMPT).toMatch(/say once in one short line what you are about to do/);
    expect(QUIET_WORK_PROMPT).toMatch(/Screenshots you take are for you/);
    expect(workUpdatesPrompt(true)).toBe(STEP_UPDATES_PROMPT);
    expect(STEP_UPDATES_PROMPT).toMatch(/step-by-step updates/);
  });

  it("switches off the engine's own nudge to post status lines only while quiet", () => {
    expect(quietWorkEnvironment(true)).toEqual({ CLAUDE_CODE_SILENT_TURN_REMINDER: "0" });
    expect(quietWorkEnvironment(false)).toEqual({});
    expect(quietWorkEnvironment(undefined)).toEqual({});
  });
});
