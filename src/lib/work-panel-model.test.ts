import { describe, expect, it } from "vitest";
import type { NativeActivity, NativeActor, NativeRun } from "../../shared/native-runs";
import type { CloudTaskSummary } from "../../shared/cloud-task";
import { stepPhrase } from "../../shared/step-words";
import { helperRows, panelTitle, sideJobCards, stepDetail, stepRows, todoRows } from "./work-panel-model";

const at = (h: number, m: number) => new Date(2026, 10, 17, h, m).getTime();
const NOW = at(9, 41);
const main: NativeActor = { id: "parent", kind: "parent", label: "Juniper", state: "running", startedAt: at(9, 24) } as NativeActor;
const run = (over: Partial<NativeRun> = {}): NativeRun => ({ id: "r1", botId: "b1", threadId: "t1", turnId: "u1", provider: "claudeAgent", revision: 1, startedAt: at(9, 24), state: "running", observation: "live", actors: [main], activityCount: 4, failureCount: 0, limitations: [], nativeActivity: true, ...over });
const act = (id: string, label: string, h: number, m: number, over: Partial<NativeActivity> = {}): NativeActivity => ({ id, actorId: "parent", kind: "tool", label, state: "done", startedAt: at(h, m), endedAt: at(h, m) + 30_000, ...over });

describe("steps", () => {
  const activities = [
    act("a1", "Read", 9, 25, { subject: "order form" }),
    act("a2", "Grep", 9, 25, { subject: "pickup", startedAt: at(9, 25) + 10_000 }),
    act("a3", "Bash", 9, 31, { subject: "Run the order form tests", state: "failed" }),
    act("a4", "Edit", 9, 38, { subject: "order form" }),
    act("a5", "TodoWrite", 9, 39),
    act("a6", "", 9, 39, { kind: "reasoning" }),
    act("a7", "", 9, 39, { kind: "message" }),
    act("a8", "Bash", 9, 38, { subject: "Run the order form tests", state: "running", startedAt: at(9, 38) }),
  ];
  const live = run({ currentActivity: { id: "a8", actorId: "parent", kind: "tool", label: "Bash", state: "running", startedAt: at(9, 38) }, lastActivityAt: at(9, 40) });

  it("lists the live step first, then finished steps newest first, leaving out plans, words and thoughts", () => {
    const { rows } = stepRows(live, activities, NOW);
    expect(rows.map(row => row.label)).toEqual([stepPhrase("running", "a8"), "Changed the order form", "Ran the order form tests", "Searched for “pickup”", "Read the order form"]);
    expect(rows.map(row => row.glyph)).toEqual(["spinner", "pencil", "play", "magnifier", "page"]);
  });

  it("times the live step now, then for 3 min, and finished ones by the clock", () => {
    expect(stepRows(live, activities, at(9, 38) + 20_000).rows[0]!.time).toBe("now");
    expect(stepRows(live, activities, NOW).rows[0]!.time).toBe("for 3 min");
    expect(stepRows(live, activities, NOW).rows[1]!.time).toBe("9:38");
  });

  it("marks a failed step and gives it the danger glyph", () => {
    const failed = stepRows(live, activities, NOW).rows.find(row => row.id === "a3")!;
    expect(failed.failed).toBe(true);
  });

  it("falls back to the kind's own words when a step has no subject, and never shows a tool name, count or path", () => {
    const { rows } = stepRows(run({ observation: "complete", state: "done" }), [act("b1", "Bash", 9, 30), act("b2", "mcp__agents__run_on_computer", 9, 31), act("b3", "Edit", 9, 32)], NOW);
    expect(rows.map(row => row.label)).toEqual(["Made a change", "Tried something", "Tried something"]);
    for (const row of rows) expect(row.label).not.toMatch(/Bash|Edit|mcp__|run_on_computer|\d+ (?:steps|tokens)|\//);
  });

  it("says earlier steps aren't kept when the run was trimmed", () => {
    expect(stepRows(run({ truncated: true }), activities, NOW).trimmed).toBe(true);
    expect(stepRows(live, activities, NOW).trimmed).toBe(false);
  });

  it("leaves a helper's own steps out of its dog's list", () => {
    const { rows } = stepRows(live, [...activities, act("p1", "Edit", 9, 40, { actorId: "puppy-1", subject: "menu" })], NOW);
    expect(rows.some(row => row.id === "p1")).toBe(false);
  });
});

describe("the to-do list", () => {
  const plan = { updatedAt: 1, items: [
    { text: "Add a pickup time field", status: "done" as const },
    { text: "Check the form on a small phone", status: "in_progress" as const },
    { text: "Tell you what changed", status: "pending" as const },
  ] };
  it("marks done, current and next, with a spinner only while the dog works", () => {
    expect(todoRows(plan, true).map(row => row.mark)).toEqual(["done", "working", "next"]);
    expect(todoRows(plan, false).map(row => row.mark)).toEqual(["done", "current", "next"]);
    expect(todoRows(null, true)).toEqual([]);
  });
});

describe("dogs helping", () => {
  it("shows each helping dog's phrase with its age after a minute, or that it needs an answer", () => {
    const rows = helperRows([
      { botId: "o", name: "Otis", state: "running", step: { id: "s1", kind: "reading", startedAt: NOW - 2 * 60_000, lastActivityAt: NOW } },
      { botId: "w", name: "Wren", state: "running", step: { id: "s2", kind: "running", startedAt: NOW - 20_000, lastActivityAt: NOW } },
      { botId: "p", name: "Pip", state: "needsYou" },
    ], NOW);
    expect(rows.map(row => row.phrase)).toEqual([expect.stringMatching(/ · for 2 min$/), expect.not.stringMatching(/for/), "Needs your answer"]);
    expect(rows[2]!.needsYou).toBe(true);
  });
});

describe("side jobs", () => {
  const puppy: NativeActor = { id: "puppy-1", parentId: "parent", kind: "subagent", label: "Checking the order form on three phone sizes", state: "running", startedAt: NOW - 4 * 60_000, lastActivityAt: NOW - 10_000, background: true } as NativeActor;
  const job = { id: "j1", title: "Keeping the order form open to look at it", state: "running", startedAt: new Date(NOW - 6 * 60_000).toISOString(), updatedAt: new Date(NOW - 60_000).toISOString(), stoppable: true } as unknown as CloudTaskSummary;
  it("lists running background work with how long it has gone and when it last moved, and only coding jobs can stop", () => {
    const cards = sideJobCards(run({ actors: [main, puppy] }), [job], NOW);
    expect(cards.running.map(card => [card.title, card.meta, card.canStop])).toEqual([
      ["Keeping the order form open to look at it", "Going for 6 min · last moved 1 min ago", true],
      ["Checking the order form on three phone sizes", "Going for 4 min · last moved just now", false],
    ]);
  });
  it("counts a background task as a side job even when the engine could not say which actor started it", () => {
    const orphan = { ...puppy, id: "task-1", kind: "task", parentId: undefined, label: "Watching the build" } as NativeActor;
    expect(sideJobCards(run({ actors: [main, orphan] }), [], NOW).running.map(card => card.title)).toEqual(["Watching the build"]);
    expect(stepRows(run({ actors: [main, orphan] }), [act("o1", "Edit", 9, 40, { actorId: "task-1", subject: "menu" })], NOW).rows.some(row => row.id === "o1")).toBe(false);
  });

  it("says just started under a minute", () => {
    const fresh = { ...puppy, startedAt: NOW - 20_000 };
    expect(sideJobCards(run({ actors: [main, fresh] }), [], NOW).running[0]!.meta).toBe("Just started");
  });
});

describe("one step and the titles", () => {
  it("names what went in by the step's kind, and what came back", () => {
    expect(stepDetail(act("x", "Bash", 9, 30, { input: "pnpm test", output: "ok" })).inputLabel).toBe("What it ran");
    expect(stepDetail(act("x", "Read", 9, 30)).inputLabel).toBe("What it read");
    expect(stepDetail(act("x", "Edit", 9, 30)).inputLabel).toBe("What it changed");
    expect(stepDetail(act("x", "Write", 9, 30)).inputLabel).toBe("What it wrote");
    expect(stepDetail(act("x", "Grep", 9, 30)).inputLabel).toBe("What it looked for");
    expect(stepDetail(act("x", "Task", 9, 30)).inputLabel).toBe("What it asked");
    expect(stepDetail(act("x", "mystery", 9, 30)).inputLabel).toBe("What it sent");
    expect(stepDetail(act("x", "Bash", 9, 30)).outputLabel).toBe("What came back");
  });
  it("titles the page by what the dog is doing, did, or the page's own name", () => {
    expect(panelTitle({ kind: "work", threadId: "t1" }, "Juniper")).toBe("What Juniper is doing");
    expect(panelTitle({ kind: "work", threadId: "t1", runId: "r1" }, "Juniper")).toBe("What Juniper did");
    expect(panelTitle({ kind: "side-jobs", threadId: "t1" }, "Juniper")).toBe("Side jobs");
  });
});

describe("finished side jobs", () => {
  it("never says a finished job is still going", () => {
    const done = { id: "j2", title: "Built the preview", state: "succeeded", startedAt: new Date(NOW - 46 * 60_000).toISOString(), updatedAt: new Date(NOW - 40 * 60_000).toISOString(), finishedAt: new Date(NOW - 40 * 60_000).toISOString(), stoppable: false } as unknown as CloudTaskSummary;
    const card = sideJobCards(run(), [done], NOW).finished[0]!;
    expect(card.meta).not.toMatch(/Going/);
    expect(card.meta).toBe("Last moved 40 min ago");
  });
});

describe("step glyphs", () => {
  it("gives a command on the dog's computer the play glyph and a coding job the cloud", () => {
    const rows = stepRows(run({ observation: "complete", state: "done" }), [act("c1", "mcp__agents__run_on_computer", 9, 30), act("c2", "mcp__laterdog__delegate_cloud_job", 9, 31)], NOW).rows;
    expect(Object.fromEntries(rows.map(row => [row.id, row.glyph]))).toEqual({ c1: "play", c2: "cloud" });
  });
});
