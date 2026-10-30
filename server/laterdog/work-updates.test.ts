import { describe, expect, it } from "vitest";

import { BACKGROUND_WORK_PROMPT, KEEP_GOING_PROMPT, KEEP_GOING_WITH_BACKGROUND_PROMPT, MILESTONE_PROMPT, ON_IT_NOTE, QUIET_WORK_PROMPT, quietWorkEnvironment, STEER_NOTE, withOnItNote, withSteerNote, workUpdatesPrompt } from "./work-updates.ts";

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
    expect(workUpdatesPrompt()).not.toMatch(/in the background/);
  });

  it("tells a dog whose engine can work in the background to run long jobs there and stay free to answer", () => {
    const prompt = workUpdatesPrompt({ background: true });
    expect(prompt).toBe(QUIET_WORK_PROMPT + MILESTONE_PROMPT + BACKGROUND_WORK_PROMPT + KEEP_GOING_WITH_BACKGROUND_PROMPT);
    expect(prompt).toMatch(/in the background, so you stay free to answer the person while it runs/);
    expect(prompt).toMatch(/You may end your turn while background work runs: you are told when it finishes/);
    expect(prompt).toMatch(/Apart from background work, never end your turn on a line about what you will do next/);
    expect(prompt).not.toContain(KEEP_GOING_PROMPT);
  });

  it("puts the on-it note after the person's message, where the engine reads it last", () => {
    expect(withOnItNote("Which branch is ~/code/dog on?")).toBe(`Which branch is ~/code/dog on?\n\n${ON_IT_NOTE}`);
    expect(ON_IT_NOTE).toMatch(/if this needs a tool, send your one short on-it line first, before the first tool call/);
  });

  it("has a dog answer a message sent while it works straight away, not when the work is done", () => {
    expect(QUIET_WORK_PROMPT).toMatch(/When the person writes to you while you work, reply in a short line straight away, before your next tool call, then carry on/);
    expect(withSteerNote("also check the logs")).toBe(`also check the logs\n\n${STEER_NOTE}`);
    expect(STEER_NOTE).toMatch(/sent this while you were working\. Reply to it now in a short line, before your next tool call/);
  });

  it("switches off the engine's own nudge to post status lines only while quiet", () => {
    expect(quietWorkEnvironment(true)).toEqual({ CLAUDE_CODE_SILENT_TURN_REMINDER: "0" });
    expect(quietWorkEnvironment(false)).toEqual({});
    expect(quietWorkEnvironment(undefined)).toEqual({});
  });
});
