import { describe, expect, it } from "vitest";
import { BUSY_TURN, NOTHING_SHOWN, PACE, busyTimeline, pace, roomFor, stepLine, turnStates, visibleChanges, type SlotLine } from "./wait-and-landing-model.ts";

const states = turnStates();
const lines = states.flatMap((state) => (state.line ? [state.line] : []));
const shownWords = (line: SlotLine) => [line.words, line.age, line.sideJobs].filter(Boolean).join(" · ");
const NAMED = new Set(["long-step", "helpers", "room-many", "helper-needs-you", "needs-account", "moving-account", "computer-background", "computer-job"]);

describe("the turn slot's states", () => {
  it("gives every state a line, a fold form or an outcome, so none is left without a home", () => {
    for (const state of states) expect(state.line !== null || state.fold !== undefined || state.outcome !== undefined, state.id).toBe(true);
    expect(new Set(states.map((state) => state.id)).size).toBe(states.length);
  });

  it("covers delivery, work, waiting on the person, waiting on something else, the ends and rooms", () => {
    expect(new Set(states.map((state) => state.group))).toEqual(new Set(["Delivery", "Working", "Waiting on you", "Waiting on something else", "Ends", "Rooms"]));
  });

  it("keeps fixed words short enough for one line on a 393 point phone", () => {
    for (const state of states) {
      if (!state.line || NAMED.has(state.id)) continue;
      expect(state.line.words.length, state.id).toBeLessThanOrEqual(30);
    }
  });

  it("never names a tool, a path, a command or seconds, in what it shows or says", () => {
    const said = [...lines.flatMap((line) => [shownWords(line), line.spoken]), ...states.flatMap((state) => (state.fold ? [state.fold.words, state.fold.spoken] : []))];
    for (const text of said) {
      expect(text, text).not.toMatch(/\/|\.(?:tsx?|md|json)\b|\b(?:bash|grep|glob|pnpm|npm|mcp|tool|seconds?)\b|\d+\s?s\b/i);
    }
  });

  it("speaks a whole sentence for every line", () => {
    for (const line of lines) expect(line.spoken, line.key).toMatch(/^[A-Z0-9].*[.?]$/);
  });

  it("asks in the waiting colour, at once, only when the person is needed", () => {
    for (const state of states) {
      if (!state.line) continue;
      const asks = state.group === "Waiting on you" || state.id === "room-asks";
      expect(state.line.tone === "asks", state.id).toBe(asks);
      expect(state.line.urgent, state.id).toBe(asks);
      if (asks) expect(state.line.face).toBe("alerting");
    }
  });
});

describe("how often the slot may change", () => {
  const step = (kind: "reading" | "editing" | "running" | "thinking") => stepLine({ kind, runKey: "turn" });
  const ask = states.find((state) => state.id === "needs-ok")!.line!;

  it("shows the first line at once", () => {
    expect(pace(NOTHING_SHOWN, step("thinking"), 0).shown?.key).toBe("thinking:turn");
  });

  it("lets a burst of steps through only after the new one has settled and the old one has been read", () => {
    let paced = pace(NOTHING_SHOWN, step("thinking"), 0);
    paced = pace(paced, step("reading"), 200);
    paced = pace(paced, step("editing"), 400);
    paced = pace(paced, step("running"), 600);
    expect(paced.shown?.key).toBe("thinking:turn");
    paced = pace(paced, step("running"), 600 + PACE.settleMs);
    expect(paced.shown?.key).toBe("thinking:turn");
    paced = pace(paced, step("running"), PACE.holdMs);
    expect(paced.shown?.key).toBe("running:turn");
  });

  it("keeps one phrase for one kind of step for the whole turn", () => {
    expect(step("reading").words).toBe(stepLine({ kind: "reading", runKey: "turn" }).words);
    expect(step("reading").key).toBe(step("reading").key);
  });

  it("shows a request for the person at once, and leaves it at once when answered", () => {
    let paced = pace(NOTHING_SHOWN, step("running"), 0);
    paced = pace(paced, ask, 100);
    expect(paced.shown?.key).toBe("needs-ok");
    paced = pace(paced, step("running"), 150);
    expect(paced.shown?.key).toBe("running:turn");
  });

  it("updates the age under a phrase that stays, without counting a change", () => {
    let paced = pace(NOTHING_SHOWN, stepLine({ kind: "running", runKey: "turn", runMs: 30_000 }), 0);
    paced = pace(paced, stepLine({ kind: "running", runKey: "turn", runMs: 61_000 }), 31_000);
    expect(paced.shown?.age).toBe("for 1 min");
    expect(paced.shownAt).toBe(0);
  });

  it("changes the busy turn's line four times in 77 seconds, never sooner than one hold apart", () => {
    const changes = visibleChanges(busyTimeline());
    expect(changes.map((change) => change.words)).toEqual([
      expect.any(String),
      "Trying it out",
      "Running the order form tests · for 1 min",
      "Writing back",
    ]);
    for (let index = 1; index < changes.length; index += 1) expect(changes[index]!.at - changes[index - 1]!.at).toBeGreaterThanOrEqual(PACE.holdMs);
    expect(changes.at(-1)!.at).toBeLessThan(BUSY_TURN.landsAt);
  });
});

describe("room for the answer", () => {
  it("reserves four tenths of the visible transcript, never less than the slot", () => {
    expect(roomFor(612, 32)).toBe(245);
    expect(roomFor(40, 32)).toBe(32);
  });
});
