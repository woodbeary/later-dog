import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { STEP_LIMIT, turnSteps, turnUpdates } from "./turn-details";

let seq = 0;
const tool = (name: string, ok: boolean | undefined, at: number, extra: Partial<Message> = {}): Message =>
  ({ id: `s${++seq}`, role: "bot", kind: "activity", at, tool: { name, ...(ok === undefined ? {} : { ok }) }, ...extra });
const said = (text: string, at: number): Message => ({ id: `m${++seq}`, role: "bot", kind: "text", at, text });

describe("what the dog did this turn", () => {
  it("lists this turn's tool steps in order with their state, in plain words", () => {
    const steps = turnSteps([
      tool("Read", true, 5),
      tool("Bash", false, 6),
      tool("mcp__computer__click", undefined, 7),
    ], 1);
    expect(steps.map((step) => [step.label, step.state])).toEqual([
      ["Reading a file", "done"],
      ["Running a command", "failed"],
      ["Using the computer", "running"],
    ]);
  });

  it("leaves out steps it can only call working, unless they failed", () => {
    const steps = turnSteps([
      tool("ToolSearch", true, 5),
      tool("Read", true, 6),
      tool("ToolSearch", undefined, 7),
      tool("ToolSearch", false, 8),
    ], 1);
    expect(steps.map((step) => [step.label, step.state])).toEqual([
      ["Reading a file", "done"],
      ["Working", "failed"],
    ]);
  });

  it("leaves out earlier turns, navigation chips and status notes", () => {
    const steps = turnSteps([
      tool("Read", true, 1),
      tool("Edit", true, 20),
      tool("Opened thread", true, 21, { threadRef: { botId: "a", threadId: "b", title: "c" } }),
      tool("notice: heads up", true, 22),
      { id: "u", role: "user", kind: "text", at: 23, text: "hi" },
    ], 10);
    expect(steps.map((step) => step.label)).toEqual(["Editing a file"]);
  });

  it("never lists the dog's status line as a step, live or folded", () => {
    const steps = turnSteps([
      tool("Bash", undefined, 20, { tool: { name: "Bash", spoken: "running the tests" } }),
      tool("notice: Still on it: running the tests", true, 21, { tool: { name: "notice: Still on it: running the tests", ok: true, statusLine: "live" } }),
      tool("Still on it: making edits", true, 22, { tool: { name: "Still on it: making edits", ok: true, statusLine: "folded", spoken: "making edits" } }),
    ], 10);
    expect(steps.map((step) => step.label)).toEqual(["Running the tests"]);
  });

  it("keeps only the latest steps of a long turn", () => {
    const many = Array.from({ length: STEP_LIMIT + 5 }, (_, index) => tool("Grep", true, 10 + index));
    const steps = turnSteps(many, 0);
    expect(steps).toHaveLength(STEP_LIMIT);
    expect(steps.at(-1)?.id).toBe(many.at(-1)?.id);
  });

  it("collects the lines the chat folded away this turn, shortened", () => {
    const folded = said("Halfway through the notes.", 30);
    const kept = said("Opening the page.", 31);
    const old = said("An earlier turn.", 2);
    const long = said("x".repeat(400), 32);
    const lines = turnUpdates([old, folded, kept, long], new Set([old.id, folded.id, long.id]), 10);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Halfway through the notes.");
    expect(lines[1]!.length).toBeLessThanOrEqual(280);
    expect(lines[1]!.endsWith("…")).toBe(true);
  });
});
