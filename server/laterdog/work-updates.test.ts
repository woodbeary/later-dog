import { describe, expect, it } from "vitest";

import { BACKGROUND_WORK_PROMPT, KEEP_GOING_PROMPT, KEEP_GOING_WITH_BACKGROUND_PROMPT, MILESTONE_PROMPT, ON_IT_NOTE, QUIET_WORK_PROMPT, quietWorkEnvironment, STEER_NOTE, withOnItNote, withSteerNote, workUpdatesPrompt } from "./work-updates.ts";

describe("how a dog keeps the person posted", () => {
  it("asks for updates instead of silence, without step-by-step narration", () => {
    expect(workUpdatesPrompt()).toBe(QUIET_WORK_PROMPT + MILESTONE_PROMPT + KEEP_GOING_PROMPT);
    expect(QUIET_WORK_PROMPT).toMatch(/between your one-line updates do not narrate each step/);
    expect(QUIET_WORK_PROMPT).toMatch(/Screenshots you take are for you/);
    expect(workUpdatesPrompt()).not.toMatch(/Work quietly|do not post progress notes|without commentary between tool calls/);
    expect(workUpdatesPrompt()).not.toMatch(/step-by-step updates/);
  });

  it("never has a dog guess how long something will take", () => {
    expect(workUpdatesPrompt()).toMatch(/Leave out time estimates unless the person asks how long something will take/);
  });

  it("tells every dog never to end a turn on what it is about to do", () => {
    expect(workUpdatesPrompt()).toMatch(/do not end it on a line about what you will do next/);
    expect(workUpdatesPrompt()).toMatch(/Nothing happens after your turn ends/);
    expect(workUpdatesPrompt()).toMatch(/or say in one line what is stopping you/);
    expect(workUpdatesPrompt()).not.toMatch(/in the background/);
  });

  it("tells a dog whose engine can work in the background to run long jobs there and stay free to answer", () => {
    const prompt = workUpdatesPrompt({ background: true });
    expect(prompt).toBe(QUIET_WORK_PROMPT + MILESTONE_PROMPT + BACKGROUND_WORK_PROMPT + KEEP_GOING_WITH_BACKGROUND_PROMPT);
    expect(prompt).toMatch(/You may end your turn while background work runs: you are told when it finishes/);
    expect(prompt).toMatch(/Apart from background work, nothing happens after your turn ends, so do not end it on a line about what you will do next/);
    expect(prompt).not.toContain(KEEP_GOING_PROMPT);
  });

  it("puts the on-it note after the person's message, where the engine reads it last", () => {
    expect(withOnItNote("Which branch is ~/code/dog on?")).toBe(`Which branch is ~/code/dog on?\n\n${ON_IT_NOTE}`);
    expect(ON_IT_NOTE).toMatch(/^\[later\.dog note, not typed by the person: if this needs a tool, send your one short on-it line first, before the first tool call/);
  });

  it("has a dog answer a message sent while it works straight away, not when the work is done", () => {
    expect(QUIET_WORK_PROMPT).toMatch(/When the person writes to you while you work, reply in a short line straight away, before your next tool call, then carry on/);
    expect(withSteerNote("also check the logs")).toBe(`also check the logs\n\n${STEER_NOTE}`);
    expect(STEER_NOTE).toMatch(/^\[later\.dog note, not typed by the person: the person sent this while you were working\. Reply to it now in a short line, before your next tool call/);
  });

  it("switches off the engine's own nudge to post status lines only while quiet", () => {
    expect(quietWorkEnvironment(true)).toEqual({ CLAUDE_CODE_SILENT_TURN_REMINDER: "0" });
    expect(quietWorkEnvironment(false)).toEqual({});
    expect(quietWorkEnvironment(undefined)).toEqual({});
  });
});
