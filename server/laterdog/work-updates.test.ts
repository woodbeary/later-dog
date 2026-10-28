import { describe, expect, it } from "vitest";

import { KEEP_GOING_PROMPT, MILESTONE_PROMPT, ON_IT_NOTE, QUIET_WORK_PROMPT, quietWorkEnvironment, withOnItNote, workUpdatesPrompt } from "./work-updates.ts";

describe("how a dog keeps the person posted", () => {
  it("always works quietly", () => {
    expect(workUpdatesPrompt()).toBe(QUIET_WORK_PROMPT + MILESTONE_PROMPT + KEEP_GOING_PROMPT);
    expect(QUIET_WORK_PROMPT).toMatch(/do not narrate your steps/);
    expect(QUIET_WORK_PROMPT).toMatch(/Finish with one clear answer/);
    expect(QUIET_WORK_PROMPT).toMatch(/Unless you can answer straight away without a tool, start with one short line saying you are on it and what you are about to do, and send it before your first tool call/);
    expect(QUIET_WORK_PROMPT).toMatch(/Quick jobs get that line too, a single command included/);
    expect(QUIET_WORK_PROMPT).toMatch(/Screenshots you take are for you/);
    expect(workUpdatesPrompt()).not.toMatch(/step-by-step updates/);
  });

  it("tells every dog to post a line at each milestone of a long task and never to guess how long it will take", () => {
    expect(workUpdatesPrompt()).toMatch(/post one short plain line each time you pass a milestone/);
    expect(workUpdatesPrompt()).toMatch(/Never give time estimates or say how long something will take unless the person asks/);
  });

  it("tells every dog never to end a turn on what it is about to do", () => {
    expect(workUpdatesPrompt()).toMatch(/Never end your turn on a line about what you will do next/);
    expect(workUpdatesPrompt()).toMatch(/nothing happens after your turn ends/);
  });

  it("puts the on-it note after the person's message, where the engine reads it last", () => {
    expect(withOnItNote("Which branch is ~/code/dog on?")).toBe(`Which branch is ~/code/dog on?\n\n${ON_IT_NOTE}`);
    expect(ON_IT_NOTE).toMatch(/if this needs a tool, send your one short on-it line first, before the first tool call/);
  });

  it("switches off the engine's own nudge to post status lines only while quiet", () => {
    expect(quietWorkEnvironment(true)).toEqual({ CLAUDE_CODE_SILENT_TURN_REMINDER: "0" });
    expect(quietWorkEnvironment(false)).toEqual({});
    expect(quietWorkEnvironment(undefined)).toEqual({});
  });
});
