import { describe, expect, it } from "vitest";

import { MILESTONE_PROMPT, QUIET_WORK_PROMPT, STEP_UPDATES_PROMPT, quietWorkEnvironment, workUpdatesPrompt } from "./work-updates.ts";

describe("how a dog keeps the person posted", () => {
  it("works quietly unless the person asked for step-by-step updates", () => {
    expect(workUpdatesPrompt(false)).toBe(QUIET_WORK_PROMPT + MILESTONE_PROMPT);
    expect(QUIET_WORK_PROMPT).toMatch(/do not narrate your steps/);
    expect(QUIET_WORK_PROMPT).toMatch(/Finish with one clear answer/);
    expect(QUIET_WORK_PROMPT).toMatch(/say once in one short line what you are about to do/);
    expect(QUIET_WORK_PROMPT).toMatch(/Screenshots you take are for you/);
    expect(workUpdatesPrompt(true)).toBe(STEP_UPDATES_PROMPT + MILESTONE_PROMPT);
    expect(STEP_UPDATES_PROMPT).toMatch(/step-by-step updates/);
  });

  it("tells every dog to post a line at each milestone of a long task and never to guess how long it will take", () => {
    for (const prompt of [workUpdatesPrompt(false), workUpdatesPrompt(true)]) {
      expect(prompt).toMatch(/post one short plain line each time you pass a milestone/);
      expect(prompt).toMatch(/Never give time estimates or say how long something will take unless the person asks/);
    }
  });

  it("switches off the engine's own nudge to post status lines only while quiet", () => {
    expect(quietWorkEnvironment(true)).toEqual({ CLAUDE_CODE_SILENT_TURN_REMINDER: "0" });
    expect(quietWorkEnvironment(false)).toEqual({});
    expect(quietWorkEnvironment(undefined)).toEqual({});
  });
});
