import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORK_PRIORITY, type WorkKind } from "../../shared/work-state.ts";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import { LimitHold } from "./limit-hold.ts";
import { WorkSignals } from "./work-signals.ts";
import { openAsk, workState, type WorkFacts } from "./work-state.ts";

const scout = { botId: "scout", name: "Scout", ask: "Check the invoice totals" };
const every: Required<WorkFacts> = {
  busy: true,
  helpers: 0,
  computerJobs: 0,
  computerSince: 0,
  handoffRunning: false,
  needsYou: { what: "Allow sending the email?" },
  usageHold: { account: "Work account", until: 1_800_000_000_000 },
  waitingOn: [scout],
  computerWait: { holder: "Patch" },
  retry: { attempt: 2 },
  stopped: { cause: "engine" },
};

const without = (...keys: Array<keyof WorkFacts>): WorkFacts =>
  Object.fromEntries(Object.entries(every).filter(([key]) => !keys.includes(key as keyof WorkFacts))) as unknown as WorkFacts;

describe("one work state per chat", () => {
  it.each<[string, WorkFacts, ReturnType<typeof workState>]>([
    ["nothing happening", { busy: false }, { kind: "idle" }],
    ["a running turn", { busy: true }, { kind: "running" }],
    ["helpers still working after the dog's own turn", { busy: false, helpers: 2 }, { kind: "running", helpers: 2 }],
    ["helpers working outrank an earlier stop", { busy: false, helpers: 1, stopped: { cause: "engine" } }, { kind: "running", helpers: 1 }],
    ["a job on its computer after the turn", { busy: false, computerJobs: 1 }, { kind: "running", computerJobs: 1 }],
    ["a handoff it is doing for another dog", { busy: false, handoffRunning: true }, { kind: "running" }],
    ["a question for the person", { busy: true, needsYou: { what: " Allow sending? " } }, { kind: "needs-you", what: "Allow sending?" }],
    ["a question with no label", { busy: false, needsYou: {} }, { kind: "needs-you" }],
    ["a usage hold", { busy: false, usageHold: { account: "Work", until: 5 } }, { kind: "waiting-for-usage", account: "Work", until: 5 }],
    ["a usage hold with no reset time", { busy: false, usageHold: {} }, { kind: "waiting-for-usage" }],
    ["another dog", { busy: false, waitingOn: [scout, { ...scout, ask: undefined }] }, { kind: "waiting-on-dog", dogs: [{ id: "scout", name: "Scout", ask: "Check the invoice totals" }] }],
    ["a nameless teammate is not invented", { busy: false, waitingOn: [{ botId: "x", name: " " }] }, { kind: "idle" }],
    ["the computer", { busy: true, computerWait: { holder: "Patch" } }, { kind: "waiting-for-computer", holder: "Patch" }],
    ["a retry", { busy: true, retry: { attempt: 2 } }, { kind: "retrying", attempt: 2 }],
    ["a retry with no count", { busy: true, retry: { attempt: 0 } }, { kind: "retrying" }],
    ["a stop", { busy: false, stopped: { cause: "you" } }, { kind: "stopped", cause: "you" }],
  ])("%s", (_name, facts, expected) => {
    expect(workState(facts)).toEqual(expected);
  });

  it.each(WORK_PRIORITY.slice(0, -1).map((kind, index) => [kind, index] as const))("%s wins over everything after it", (kind, index) => {
    const order: Array<[WorkKind, keyof WorkFacts]> = [
      ["needs-you", "needsYou"], ["waiting-for-usage", "usageHold"], ["waiting-on-dog", "waitingOn"],
      ["waiting-for-computer", "computerWait"], ["retrying", "retry"], ["running", "busy"], ["stopped", "stopped"],
    ];
    const above = order.slice(0, index).map(([, key]) => key);
    const facts = without(...above);
    expect(workState({ ...facts, busy: !above.includes("busy") }).kind).toBe(kind);
  });

  it("names the newest open question, skipping answered ones", () => {
    expect(openAsk([
      { role: "bot", card: { title: "Allow sending the email?" } },
      { role: "bot", card: { title: "Old", answered: "Allow" } },
    ])).toBe("Allow sending the email?");
    expect(openAsk([{ role: "bot", needsYou: { label: "Scout needs your sign-in", status: "waiting" } }])).toBe("Scout needs your sign-in");
    expect(openAsk([{ role: "bot", card: { title: "Done", dismissed: true } }])).toBeUndefined();
  });

  it("a stop no longer shows once a new turn runs", () => {
    expect(workState({ busy: true, stopped: { cause: "engine" } })).toEqual({ kind: "running" });
  });
});

const event = (body: Record<string, unknown>): RuntimeEvent =>
  ({ eventId: "e", provider: "fake", threadId: "t1", createdAt: "2026-11-11T00:00:00Z", ...body }) as RuntimeEvent;

describe("signals the home records from runtime events", () => {
  it("a retry shows its try number and clears once output arrives", () => {
    const signals = new WorkSignals();
    signals.observe(event({ type: "turn.started" }));
    expect(signals.observe(event({ type: "turn.retrying", attempt: 1, delayMs: 2000, reason: "overloaded" }))).toBe(true);
    expect(workState({ busy: true, ...signals.facts("t1") })).toEqual({ kind: "retrying", attempt: 2 });
    signals.observe(event({ type: "content.delta", streamKind: "assistant_text", delta: "hi" }));
    expect(workState({ busy: true, ...signals.facts("t1") })).toEqual({ kind: "running" });
  });

  it("a computer wait names who holds it and ends when acquired", () => {
    const signals = new WorkSignals();
    signals.observe(event({ type: "turn.wait_started", resource: "mac", holder: { name: "Patch" } }));
    expect(workState({ busy: true, ...signals.facts("t1") })).toEqual({ kind: "waiting-for-computer", holder: "Patch" });
    signals.observe(event({ type: "turn.wait_ended", resource: "mac", waitedMs: 5, outcome: "acquired" }));
    expect(workState({ busy: true, ...signals.facts("t1") })).toEqual({ kind: "running" });
  });

  it("a failed turn is an engine stop, a person's stop is yours, and a usage limit is not a stop", () => {
    const signals = new WorkSignals();
    signals.observe(event({ type: "turn.completed", ok: false, stopReason: "error" }));
    expect(signals.facts("t1").stopped).toEqual({ cause: "engine" });
    signals.observe(event({ type: "turn.started" }));
    signals.stopRequested("t1");
    signals.observe(event({ type: "turn.completed", ok: false, stopReason: "interrupted" }));
    expect(signals.facts("t1").stopped).toEqual({ cause: "you" });
    signals.observe(event({ type: "turn.started" }));
    signals.observe(event({ type: "turn.completed", ok: false, stopReason: "usage_limit" }));
    expect(signals.facts("t1").stopped).toBeUndefined();
  });

  it("an interruption nobody asked for is not blamed on the person", () => {
    const signals = new WorkSignals();
    signals.observe(event({ type: "turn.completed", ok: false, stopReason: "interrupted" }));
    expect(signals.facts("t1").stopped).toBeUndefined();
  });

  it("a stalled turn keeps its cause through the interruption that follows", () => {
    const signals = new WorkSignals();
    signals.stalled("t1");
    signals.observe(event({ type: "turn.completed", ok: false, stopReason: "interrupted" }));
    expect(signals.facts("t1").stopped).toEqual({ cause: "infrastructure", detail: "stalled" });
  });

  it("a turn parked behind a busy computer is not shown as stopped", () => {
    const signals = new WorkSignals();
    signals.observe(event({ type: "turn.wait_ended", resource: "mac", waitedMs: 5, outcome: "parked" }));
    signals.observe(event({ type: "turn.completed", ok: false, stopReason: "exit_before_result" }));
    expect(signals.facts("t1")).toEqual({});
  });
});

describe("a thread held for usage", () => {
  const NOW = Date.parse("2026-11-11T05:00:00Z");
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  it("reports waiting for usage with its reset time rather than a failure", () => {
    const resetsAt = NOW + 60 * 60_000;
    const hold = new LimitHold({ readyAt: () => new Date(resetsAt).toISOString(), wake: vi.fn() });
    const signals = new WorkSignals();
    signals.observe(event({ type: "turn.started" }));
    signals.observe(event({ type: "turn.completed", ok: false, stopReason: "usage_limit" }));
    hold.hold("t1");
    const until = hold.heldUntil("t1");
    expect(until).toBe(resetsAt);
    expect(workState({ busy: false, ...signals.facts("t1"), usageHold: { account: "Work", until } }))
      .toEqual({ kind: "waiting-for-usage", account: "Work", until: resetsAt });
    hold.release("t1");
    expect(hold.heldUntil("t1")).toBeUndefined();
  });
});
