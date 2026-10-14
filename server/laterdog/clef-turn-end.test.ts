import { describe, expect, it } from "vitest";

import { choiceAnswer, fakeDecider, type FakeScript } from "./clef-fake-decider.ts";
import type { ClefLogRow } from "./clef-log.ts";
import {
  KEEP_GOING_NUDGE, createTurnEndWatcher, turnEndState, type TurnEndChoice, type TurnEndDeps, type TurnEndInput,
} from "./clef-turn-end.ts";

const CHOICES: TurnEndChoice[] = ["done", "question_for_person", "stopped_midway", "blocked"];

const says = (choice: TurnEndChoice, p: number): FakeScript => () => ({ answers: { ended: choiceAnswer(choice, p, CHOICES) } });

const PATH = [
  { role: "user", kind: "text", text: "Move the settings page to the new layout and fix the tests." },
  { role: "bot", kind: "activity", tool: { name: "Edit", spoken: "editing Settings.tsx" } },
  { role: "bot", kind: "activity", tool: { name: "Bash" } },
];

function input(over: Partial<TurnEndInput> = {}): TurnEndInput {
  return {
    threadId: "t1", botId: "b1", ok: true, reply: "I moved the page. Next I will update the tests.", path: PATH,
    isCurrent: () => true, stoppedByPerson: false, usageLimited: false, ...over,
  };
}

function harness(script: FakeScript, over: Partial<TurnEndDeps> = {}) {
  const decider = fakeDecider(script);
  const nudges: string[] = [];
  const rows: ClefLogRow[] = [];
  const watcher = createTurnEndWatcher({
    decider,
    enabled: () => true,
    hasBudget: () => true,
    accountAvailable: () => true,
    canStart: () => true,
    nudge: async (_input, text) => { nudges.push(text); },
    record: (row) => { rows.push(row); },
    ...over,
  });
  return { watcher, decider, nudges, rows };
}

describe("turnEndState", () => {
  it("sends the task, the last reply and the recent activity, with secrets removed", () => {
    const state = turnEndState({
      reply: "Used token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 to log in.",
      path: PATH,
    });
    expect(state.task).toBe("Move the settings page to the new layout and fix the tests.");
    expect(state.recent_activity).toEqual(["editing Settings.tsx", "Bash"]);
    expect(state.last_reply).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("keeps long text and long histories short", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ role: "bot", kind: "activity", tool: { name: `step ${index} ${"x".repeat(400)}` } }));
    const state = turnEndState({ reply: "y".repeat(10_000), path: [{ role: "user", kind: "text", text: "z".repeat(10_000) }, ...many] });
    expect(state.task.length).toBeLessThanOrEqual(1_500);
    expect(state.last_reply.length).toBeLessThanOrEqual(3_000);
    expect(state.recent_activity).toHaveLength(8);
    expect(state.recent_activity.every((line) => line.length <= 160)).toBe(true);
  });
});

describe("createTurnEndWatcher", () => {
  it("sends one short nudge when the dog stopped midway and is sure", async () => {
    const h = harness(says("stopped_midway", 0.93));
    expect(await h.watcher.afterTurn(input())).toMatchObject({ action: "nudged", streak: 1 });
    expect(h.nudges).toEqual([KEEP_GOING_NUDGE]);
    expect(KEEP_GOING_NUDGE).toBe("Keep going until it's done.");
    expect(h.rows.at(-1)).toMatchObject({ kind: "turnEnd", choice: "stopped_midway", action: "nudged", streak: 1, threadId: "t1" });
    expect(JSON.stringify(h.rows)).not.toContain("settings page");
  });

  it("leaves finished work, questions and blocked work alone", async () => {
    for (const choice of ["done", "question_for_person", "blocked"] as const) {
      const h = harness(says(choice, 0.99));
      expect(await h.watcher.afterTurn(input())).toMatchObject({ action: "left", choice });
      expect(h.nudges).toHaveLength(0);
    }
  });

  it("does not nudge below 0.8", async () => {
    const h = harness(says("stopped_midway", 0.79));
    expect(await h.watcher.afterTurn(input())).toMatchObject({ action: "left" });
    expect(h.nudges).toHaveLength(0);
    expect(h.rows.at(-1)).toMatchObject({ reason: "unsure" });
  });

  it("nudges at most three times in a row, then stops until the person speaks again", async () => {
    const h = harness(says("stopped_midway", 0.95));
    for (let turn = 1; turn <= 3; turn++) expect(await h.watcher.afterTurn(input())).toMatchObject({ action: "nudged", streak: turn });
    expect(await h.watcher.afterTurn(input())).toMatchObject({ action: "left" });
    expect(h.nudges).toHaveLength(3);
    expect(h.rows.at(-1)).toMatchObject({ reason: "nudge_limit" });
    expect(await h.watcher.afterTurn(input())).toMatchObject({ action: "nudged", streak: 1 });
  });

  it("starts the count again once the dog finishes", async () => {
    let choice: TurnEndChoice = "stopped_midway";
    const h = harness(() => ({ answers: { ended: choiceAnswer(choice, 0.95, CHOICES) } }));
    await h.watcher.afterTurn(input());
    await h.watcher.afterTurn(input());
    choice = "done";
    await h.watcher.afterTurn(input());
    expect(h.watcher.streakOf("t1")).toBe(0);
  });

  it("never nudges a task the person stopped, a failed turn, or a usage limit, and never asks then", async () => {
    const h = harness(says("stopped_midway", 0.99));
    expect(await h.watcher.afterTurn(input({ stoppedByPerson: true }))).toMatchObject({ action: "skipped", reason: "stopped_by_person" });
    expect(await h.watcher.afterTurn(input({ ok: false }))).toMatchObject({ action: "skipped", reason: "turn_failed" });
    expect(await h.watcher.afterTurn(input({ usageLimited: true }))).toMatchObject({ action: "skipped", reason: "usage_limit" });
    expect(await h.watcher.afterTurn(input({ skip: true }))).toMatchObject({ action: "skipped", reason: "not_direct_work" });
    expect(await h.watcher.afterTurn(input({ isCurrent: () => false }))).toMatchObject({ action: "skipped", reason: "superseded" });
    expect(h.decider.calls).toHaveLength(0);
    expect(h.nudges).toHaveLength(0);
  });

  it("holds back without budget, without an available account, or when the thread has moved on", async () => {
    const noBudget = harness(says("stopped_midway", 0.99), { hasBudget: () => false });
    await noBudget.watcher.afterTurn(input());
    expect(noBudget.rows.at(-1)).toMatchObject({ reason: "no_budget" });
    const noAccount = harness(says("stopped_midway", 0.99), { accountAvailable: () => false });
    await noAccount.watcher.afterTurn(input());
    expect(noAccount.rows.at(-1)).toMatchObject({ reason: "no_account" });
    const busy = harness(says("stopped_midway", 0.99), { canStart: () => false });
    await busy.watcher.afterTurn(input());
    expect(busy.rows.at(-1)).toMatchObject({ reason: "thread_moved_on" });
    const later = harness(says("stopped_midway", 0.99));
    let stopped = false;
    const decider = later.decider;
    const racing = createTurnEndWatcher({
      decider: { ask: async (...args) => { stopped = true; return decider.ask(...args); } },
      enabled: () => true, hasBudget: () => true, accountAvailable: () => true, canStart: () => true,
      nudge: async () => { throw new Error("must not run"); }, record: () => undefined,
    });
    expect(await racing.afterTurn(input({ stoppedByPerson: false, isCurrent: () => !stopped }))).toMatchObject({ action: "left" });
    for (const h of [noBudget, noAccount, busy]) expect(h.nudges).toHaveLength(0);
  });

  it("does nothing when the job is off or the decider is slow, down or broken", async () => {
    const off = harness(says("stopped_midway", 0.99), { enabled: () => false });
    expect(await off.watcher.afterTurn(input())).toMatchObject({ action: "skipped", reason: "off" });
    expect(off.decider.calls).toHaveLength(0);
    const slow = harness(() => ({ hang: true }), { budgetMs: 60 });
    expect(await slow.watcher.afterTurn(input())).toMatchObject({ action: "skipped", reason: "decider_timeout" });
    const down = harness(() => ({ fail: "unreachable" }));
    expect(await down.watcher.afterTurn(input())).toMatchObject({ action: "skipped", reason: "decider_unreachable" });
    expect([slow, down].every((h) => h.nudges.length === 0)).toBe(true);
  });

  it("gives the count back when the nudge cannot start", async () => {
    const h = harness(says("stopped_midway", 0.99), { nudge: async () => { throw new Error("busy"); } });
    expect(await h.watcher.afterTurn(input())).toMatchObject({ action: "left" });
    expect(h.watcher.streakOf("t1")).toBe(0);
    expect(h.rows.at(-1)).toMatchObject({ reason: "nudge_failed" });
  });

  it("asks one choice question with the four endings", async () => {
    const h = harness(says("done", 0.9));
    await h.watcher.afterTurn(input());
    const call = h.decider.calls[0]!;
    expect(call.seam).toBe("turnEnd");
    expect(Object.keys(call.questions)).toEqual(["ended"]);
    expect(Object.keys((call.questions.ended as { options: object }).options)).toEqual(CHOICES);
    expect(call.options.timeoutMs).toBe(1_500);
  });
});
