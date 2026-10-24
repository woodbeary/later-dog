import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import { createTurnTiming } from "./turn-timing.ts";

const base = { eventId: "e", provider: "claudeAgent", threadId: "t1", turnId: "u1", createdAt: "2026-10-24T00:00:00.000Z" };
const event = (fields: Record<string, unknown>) => ({ ...base, ...fields }) as RuntimeEvent;

describe("reply timing", () => {
  it("logs when a reply started, first spoke and finished, counted from the person's message", () => {
    let at = 1_000;
    const lines: string[] = [];
    const timing = createTurnTiming({ log: (line) => lines.push(line), now: () => at });
    timing.asked("t1", "claudeAgent");
    at += 2_400;
    timing.event(event({ type: "turn.started" }));
    timing.event(event({ type: "session.started", sessionId: null, model: "claude-sonnet-5" }));
    at += 3_100;
    timing.event(event({ type: "content.delta", streamKind: "reasoning_text", delta: "thinking" }));
    at += 900;
    timing.event(event({ type: "content.delta", streamKind: "assistant_text", delta: "Pong" }));
    timing.event(event({ type: "content.delta", streamKind: "assistant_text", delta: "!" }));
    at += 600;
    timing.event(event({ type: "turn.completed", ok: true }));
    expect(lines).toEqual(["reply timing (claudeAgent, claude-sonnet-5): started 2.4 s, first words 6.4 s, done 7.0 s"]);
  });

  it("ignores turns nobody asked for here and says when a reply failed before any words", () => {
    let at = 0;
    const lines: string[] = [];
    const timing = createTurnTiming({ log: (line) => lines.push(line), now: () => at });
    timing.event(event({ type: "turn.completed", ok: true }));
    timing.asked("t1", "codex");
    at += 30_000;
    timing.event(event({ type: "turn.completed", ok: false }));
    expect(lines).toEqual(["reply timing (codex): started never, first words never, done 30.0 s, failed"]);
  });
});
