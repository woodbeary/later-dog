import { describe, expect, it } from "vitest";
import type { NativeRun } from "../../shared/native-runs";
import { EMPTY_TURN_LINE, paceTurnLine, turnRoomHeight, turnRoomRemaining, turnSlotLine, type TurnSlotLine } from "./turn-slot";

const line = (kind: "reading" | "running", at = 0) => turnSlotLine({
  name: "Scout", working: true, turnKey: "one", now: at,
  step: { id: "step", kind, startedAt: 0, lastActivityAt: 0 },
})!;

describe("the turn slot's pacing", () => {
  it("settles a new kind for a second and holds the shown phrase for two and a half seconds", () => {
    let state = paceTurnLine(EMPTY_TURN_LINE, line("reading"), 0);
    state = paceTurnLine(state, line("running"), 300);
    expect(state.shown?.words).toBe(line("reading").words);
    state = paceTurnLine(state, line("running"), 2_499);
    expect(state.shown?.words).toBe(line("reading").words);
    state = paceTurnLine(state, line("running"), 2_500);
    expect(state.shown?.words).toBe(line("running").words);
  });

  it("collapses bursts instead of showing every step or a short thinking gap", () => {
    let state = paceTurnLine(EMPTY_TURN_LINE, line("reading"), 0);
    state = paceTurnLine(state, line("running"), 1_000);
    state = paceTurnLine(state, line("reading"), 1_400);
    expect(state.pending).toBeNull();
    expect(state.shown?.words).toBe(line("reading").words);
  });

  it("shows a request for the person and leaves that request immediately", () => {
    const ask = turnSlotLine({ name: "Scout", working: true, turnKey: "one", now: 0, ask: "Waiting for your answer" })!;
    let state = paceTurnLine(EMPTY_TURN_LINE, line("reading"), 0);
    state = paceTurnLine(state, ask, 100);
    expect(state.shown?.urgent).toBe(true);
    state = paceTurnLine(state, line("running"), 101);
    expect(state.shown?.words).toBe(line("running").words);
  });

  it("updates elapsed minutes in place without counting them as a phrase change", () => {
    const first = line("running");
    const aged: TurnSlotLine = { ...first, age: "for 1 min" };
    const state = paceTurnLine(paceTurnLine(EMPTY_TURN_LINE, first, 0), aged, 60_000);
    expect(state.shownAt).toBe(0);
    expect(state.shown?.age).toBe("for 1 min");
    expect(state.pending).toBeNull();
  });

  it("waits two seconds before describing an in-flight delivery and names held delivery plainly", () => {
    const input = { name: "Scout", working: false, turnKey: "send", delivery: { at: 0 } };
    expect(turnSlotLine({ ...input, now: 1_999 })).toBeNull();
    expect(turnSlotLine({ ...input, now: 2_000 })?.words).toBe("Sending");
    expect(turnSlotLine({ ...input, delivery: { at: 0, held: true }, now: 0 })?.words).toBe("Not sent yet");
  });
});

describe("detail without a second work surface", () => {
  const input = { name: "Scout", working: true, turnKey: "one", since: 0, now: 180_000 };
  it("names several working dogs and keeps their elapsed time in the one line", () => {
    expect(turnSlotLine({ ...input, work: { kind: "running", dogs: [{ id: "pebble", name: "Pebble" }, { id: "thistle", name: "Thistle" }] } })).toMatchObject({ words: "Pebble and Thistle are working", age: "for 3 min", face: "listening" });
  });

  it("names native puppies without bringing their faces into the transcript", () => {
    const run: NativeRun = { id: "run", turnId: "turn", threadId: "thread", provider: "fixture", revision: 1, startedAt: 0,
      state: "running", observation: "live", activityCount: 1, failureCount: 0, limitations: [],
      actors: [{ id: "parent", kind: "parent", label: "Scout", state: "waiting", startedAt: 0 },
        { id: "puppy", kind: "subagent", label: "Order research", state: "running", startedAt: 0 },
        { id: "shell", kind: "task", label: "Command", state: "running", startedAt: 0 }] };
    expect(turnSlotLine({ ...input, run })).toMatchObject({ words: "Getting help from 1 puppy", age: "for 3 min", face: "listening" });
  });

  it("keeps a surviving computer command discoverable in side jobs using minutes", () => {
    expect(turnSlotLine({ ...input, busy: false, work: { kind: "running", computerJobs: 1, computerSince: 60_000 } })).toMatchObject({ words: "Running a command", age: "for 2 min", destination: "side-jobs" });
    expect(turnSlotLine({ ...input, busy: false, work: { kind: "running", computerJobs: 1, computerBackground: 1, computerSince: 0 } })).toMatchObject({ words: "Still running a command", age: "for 3 min", face: "idle" });
  });

  it("keeps the helper's answer link and distinguishes a disabled account from a signed-out one", () => {
    expect(turnSlotLine({ ...input, work: { kind: "waiting-on-dog", dogs: [{ id: "pebble", name: "Pebble", ask: "Choose one" }] } })).toMatchObject({ words: "Pebble needs your answer", openDog: "pebble", urgent: true });
    expect(turnSlotLine({ ...input, work: { kind: "needs-you", hold: { account: "Work", accountId: "work", why: "off" } } })).toMatchObject({ words: "Turn on Work to carry on", urgent: true });
  });
});

describe("room for a reply", () => {
  it("reserves forty percent of the measured visible area once", () => {
    expect(turnRoomHeight(650)).toBe(260);
    expect(turnRoomHeight(313)).toBe(125);
    expect(turnRoomHeight(0)).toBe(0);
  });

  it("consumes the room by landed content and lets a longer reply continue below it", () => {
    expect(turnRoomRemaining(1_000, 800)).toBe(200);
    expect(turnRoomRemaining(1_000, 920)).toBe(80);
    expect(turnRoomRemaining(1_000, 1_120)).toBe(0);
  });
});
