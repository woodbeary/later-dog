import { describe, expect, it } from "vitest";
import type { NativeActor, NativeRun } from "../../shared/native-runs";
import { liveStep, stepPhrase } from "../../shared/step-words";
import { sideJobCount, workLine } from "./work-line";
import { en } from "@/locales";

const parent: NativeActor = {
  id: "parent",
  kind: "parent",
  label: "Juniper",
  state: "running",
  startedAt: 0,
};

const run = (fields: Partial<NativeRun> = {}): NativeRun => ({
  id: "run-1",
  threadId: "t",
  turnId: "turn-1",
  provider: "fake",
  revision: 1,
  startedAt: 0,
  state: "running",
  observation: "live",
  actors: [parent],
  activityCount: 3,
  failureCount: 0,
  limitations: [],
  currentActivity: {
    id: "act-7",
    actorId: "parent",
    kind: "tool",
    label: "Bash",
    state: "running",
    startedAt: 1_000,
  },
  ...fields,
});

describe("the working line under the last message", () => {
  it("says the same phrase the panel's live row and the sidebar take from the live step", () => {
    const live = run();
    const line = workLine({ working: true, run: live, sideJobs: 0, now: 2_000 });
    const step = liveStep(live)!;
    expect(line).toEqual({
      kind: "step",
      stepId: "act-7",
      phrase: stepPhrase(step.kind, live.id),
      age: null,
      sideJobs: null,
    });
  });

  it("keeps one phrase per kind for the turn while step ids change", () => {
    const first = workLine({ working: true, run: run(), sideJobs: 0, now: 2_000 });
    const later = workLine({
      working: true,
      run: run({ lastActivityAt: 50_000 }),
      sideJobs: 0,
      now: 55_000,
    });
    expect(later?.kind === "step" && later.phrase).toBe(first?.kind === "step" && first.phrase);
    const next = workLine({
      working: true,
      run: run({
        currentActivity: {
          id: "act-8",
          actorId: "parent",
          kind: "tool",
          label: "Read",
          state: "running",
          startedAt: 60_000,
        },
      }),
      sideJobs: 0,
      now: 61_000,
    });
    expect(next).toMatchObject({ stepId: "act-8", phrase: stepPhrase("reading", "run-1") });
  });

  it("adds the age only after a minute on the same step", () => {
    expect(workLine({ working: true, run: run(), sideJobs: 0, now: 60_999 })).toMatchObject({
      age: null,
    });
    expect(workLine({ working: true, run: run(), sideJobs: 0, now: 61_000 })).toMatchObject({
      age: "for 1 min",
    });
    expect(workLine({ working: true, run: run(), sideJobs: 0, now: 181_000 })).toMatchObject({
      age: "for 3 min",
    });
  });

  it("falls back to the home's step when the chat has no live run", () => {
    const line = workLine({
      working: true,
      step: { id: "s-1", kind: "editing", startedAt: 0, lastActivityAt: 0 },
      sideJobs: 2,
      now: 1_000,
    });
    expect(line).toEqual({
      kind: "step",
      stepId: "s-1",
      phrase: stepPhrase("editing", "s-1"),
      age: null,
      sideJobs: "2 side jobs",
    });
  });

  it("names a helper who needs an answer before anything else, and never says it waits on a dog", () => {
    const line = workLine({
      working: true,
      run: run(),
      work: {
        kind: "waiting-on-dog",
        dogs: [
          { id: "otis", name: "Otis", ask: "Which photo?" },
          { id: "pip", name: "Pip" },
        ],
      },
      sideJobs: 0,
      now: 0,
    });
    expect(line).toEqual({
      kind: "helpers",
      text: "Otis needs your answer",
      needsYou: true,
      open: "otis",
    });
    const working = workLine({
      working: true,
      work: {
        kind: "waiting-on-dog",
        dogs: [
          { id: "b", name: "Biscuit" },
          { id: "p", name: "Pip" },
          { id: "o", name: "Otis" },
        ],
      },
      sideJobs: 0,
      now: 0,
    });
    expect(working).toEqual({
      kind: "helpers",
      text: "Biscuit, Pip and Otis are working",
      needsYou: false,
    });
    expect(JSON.stringify([line, working])).not.toContain("Waiting on");
  });

  it("says what holds the turn when the dog itself is waiting", () => {
    const waiting = run({ actors: [{ ...parent, state: "waiting" }], currentActivity: undefined });
    const words = en as Record<string, string>;
    expect(words["workLine.usage"]).toBe("Waiting for usage");
    expect(words["workLine.computer"]).toBe("Waiting for its computer");
    expect(words["workLine.retrying"]).toBe("Trying again");
    expect(words["workLine.sideJobs"]).toBe("Waiting on {sideJobs}");
    expect(workLine({ working: true, run: waiting, sideJobs: 2, now: 0 })).toEqual({
      kind: "waiting",
      text: "Waiting on 2 side jobs",
    });
    expect(
      workLine({ working: true, work: { kind: "waiting-for-usage" }, sideJobs: 0, now: 0 }),
    ).toEqual({ kind: "waiting", text: "Waiting for usage" });
    expect(
      workLine({ working: true, work: { kind: "waiting-for-computer" }, sideJobs: 0, now: 0 }),
    ).toEqual({ kind: "waiting", text: "Waiting for its computer" });
    expect(workLine({ working: true, work: { kind: "retrying" }, sideJobs: 0, now: 0 })).toEqual({
      kind: "waiting",
      text: "Trying again",
    });
  });

  it("shows nothing while the dog waits on a card, writes its answer, has stopped or is idle", () => {
    expect(
      workLine({ working: true, run: run(), work: { kind: "needs-you" }, sideJobs: 0, now: 0 }),
    ).toBeNull();
    expect(
      workLine({
        working: true,
        run: run(),
        work: { kind: "stopped", cause: "you" },
        sideJobs: 0,
        now: 0,
      }),
    ).toBeNull();
    expect(workLine({ working: false, run: run(), sideJobs: 0, now: 0 })).toBeNull();
    expect(workLine({ working: true, work: { kind: "idle" }, sideJobs: 0, now: 0 })).toBeNull();
  });

  it("counts running background work and background computer jobs as side jobs", () => {
    const background: NativeActor = {
      id: "bg",
      parentId: "parent",
      kind: "task",
      label: "Check",
      state: "running",
      startedAt: 0,
      background: true,
    };
    const done: NativeActor = { ...background, id: "bg2", state: "done" };
    expect(
      sideJobCount(run({ actors: [parent, background, done] }), {
        kind: "running",
        computerBackground: 1,
      }),
    ).toBe(2);
    expect(sideJobCount(undefined, undefined)).toBe(0);
  });
});
