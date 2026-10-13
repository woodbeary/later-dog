import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../../shared/runtime-events";
import { NO_REASONING, REASONING_TAIL_CHARS, forgetReasoning, receiveReasoningEvent, turnReasoning, withReasoningEvent } from "./turn-reasoning";

const base = { provider: "claude", threadId: "thread-a", createdAt: "2026-10-13T12:00:00.000Z" };
let serial = 0;
const at = (event: Record<string, unknown>) => ({ ...base, eventId: `e${(serial += 1)}`, turnId: "turn-1", ...event }) as RuntimeEvent;
const started = (turnId = "turn-1") => at({ type: "turn.started", turnId });
const thought = (delta: string, turnId = "turn-1") => at({ type: "content.delta", streamKind: "reasoning_text", delta, turnId });
const counted = (tokens: number | null) => at({ type: "item.updated", itemType: "reasoning", tokens });

function replay(events: RuntimeEvent[]) {
  return events.reduce<ReturnType<typeof withReasoningEvent>>((state, event) => withReasoningEvent(state, event), undefined);
}

afterEach(() => forgetReasoning());

describe("the current turn's reasoning", () => {
  it("collects streamed thinking and nothing else", () => {
    const state = replay([
      started(),
      thought("Checking the dates "),
      at({ type: "content.delta", streamKind: "assistant_text", delta: "Here is the answer" }),
      thought("against the calendar."),
    ]);
    expect(state).toMatchObject({ text: "Checking the dates against the calendar.", streamed: true, clipped: false, turnId: "turn-1" });
  });

  it("keeps only a bounded tail, starting at a word", () => {
    const word = "reasoning ";
    const state = replay([started(), ...Array.from({ length: 900 }, () => thought(word))]);
    expect(state!.text.length).toBeLessThanOrEqual(REASONING_TAIL_CHARS);
    expect(state!.text.startsWith("reasoning")).toBe(true);
    expect(state!.clipped).toBe(true);
  });

  it("starts over when a new turn begins and forgets a finished turn", () => {
    const first = replay([started(), thought("old idea")]);
    expect(withReasoningEvent(first, started("turn-2"))).toMatchObject({ text: "", streamed: false, turnId: "turn-2" });
    expect(withReasoningEvent(first, thought("new idea", "turn-2"))).toMatchObject({ text: "new idea", turnId: "turn-2" });
    expect(withReasoningEvent(first, at({ type: "turn.completed", ok: true }))).toBeUndefined();
  });

  it("does not count whitespace as streamed thinking", () => {
    expect(replay([started(), thought("\n\n")])).toMatchObject({ streamed: false });
  });
});

describe("reasoning tokens", () => {
  it("adds up each thinking block's running estimate", () => {
    const state = replay([started(), counted(120), counted(480), counted(900), counted(60), counted(300)]);
    expect(state).toMatchObject({ tokens: 1_200, streamed: false, text: "" });
  });

  it("ignores engines that only say reasoning happened", () => {
    expect(replay([started(), counted(null)])).toMatchObject({ tokens: null });
  });
});

describe("the per-thread buffer", () => {
  it("keeps threads apart and drops a thread once its turn completes", () => {
    receiveReasoningEvent(started());
    receiveReasoningEvent(thought("first thread"));
    receiveReasoningEvent({ ...thought("second thread"), threadId: "thread-b" } as RuntimeEvent);
    expect(turnReasoning("thread-a").text).toBe("first thread");
    expect(turnReasoning("thread-b").text).toBe("second thread");
    receiveReasoningEvent(at({ type: "turn.completed", ok: true }));
    expect(turnReasoning("thread-a")).toBe(NO_REASONING);
    expect(turnReasoning(null)).toBe(NO_REASONING);
  });
});
