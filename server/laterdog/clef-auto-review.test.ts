import { describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import type { RequestOutcome } from "../contracts.ts";
import {
  AUTO_ALLOW_MIN_PROBABILITY, createAutoReview, reviewAction, reviewState, type AutoReviewDeps,
} from "./clef-auto-review.ts";
import { choiceAnswer, fakeDecider, type FakeScript } from "./clef-fake-decider.ts";

const RULES = {
  allow: ["Reading files inside the project is fine.", "Running the test suite is fine."],
  block: ["Never delete anything outside the project folder."],
};
const ACTION = { tool: "Bash", summary: "run `pnpm test` in the project", command: "pnpm test" };

function script(allowed: [string, number] | null, blocked: [string, number] | null): FakeScript {
  return ({ questions }) => ({
    answers: {
      ...(questions.allowed_by ? { allowed_by: choiceAnswer(allowed?.[0] ?? "none", allowed?.[1] ?? 0.99, ["none", "rule_1", "rule_2"]) } : {}),
      ...(questions.blocked_by ? { blocked_by: choiceAnswer(blocked?.[0] ?? "none", blocked?.[1] ?? 0.99, ["none", "rule_1"]) } : {}),
    },
  });
}

describe("reviewAction", () => {
  it("allows only when a rule clearly permits the action", async () => {
    const decider = fakeDecider(script(["rule_2", 0.97], null));
    expect(await reviewAction(decider, RULES, ACTION, { mayAutoApprove: true })).toEqual({
      kind: "allow", rule: "Running the test suite is fine.", probability: 0.97,
    });
  });

  it("asks when the permitting rule is not clear enough", async () => {
    const decider = fakeDecider(script(["rule_2", AUTO_ALLOW_MIN_PROBABILITY - 0.01], null));
    expect(await reviewAction(decider, RULES, ACTION, { mayAutoApprove: true })).toEqual({ kind: "ask", reason: "unsure" });
  });

  it("asks when no rule applies", async () => {
    const decider = fakeDecider(script(["none", 0.99], ["none", 0.99]));
    expect(await reviewAction(decider, RULES, ACTION, { mayAutoApprove: true })).toEqual({ kind: "ask", reason: "unsure" });
  });

  it("blocks when a rule clearly forbids the action, and a block beats an allow", async () => {
    const decider = fakeDecider(script(["rule_1", 0.99], ["rule_1", 0.9]));
    expect(await reviewAction(decider, RULES, ACTION, { mayAutoApprove: true })).toEqual({
      kind: "block", rule: "Never delete anything outside the project folder.", probability: 0.9,
    });
  });

  it("never asks the decider and never allows without rules", async () => {
    const decider = fakeDecider(script(["rule_1", 0.99], null));
    expect(await reviewAction(decider, { allow: [], block: [] }, ACTION, { mayAutoApprove: true })).toEqual({ kind: "ask", reason: "no_rules" });
    expect(await reviewAction(decider, { allow: RULES.allow, block: [] }, ACTION, { mayAutoApprove: false })).toEqual({ kind: "ask", reason: "must_ask" });
    expect(decider.calls).toHaveLength(0);
  });

  it("never auto-approves an action the settings say must always ask, but still blocks it", async () => {
    const decider = fakeDecider(script(["rule_1", 0.99], ["rule_1", 0.95]));
    const result = await reviewAction(decider, RULES, ACTION, { mayAutoApprove: false });
    expect(result.kind).toBe("block");
    expect(Object.keys(decider.calls[0]!.questions)).toEqual(["blocked_by"]);
  });

  it("asks, without throwing, when the decider is unavailable or too slow", async () => {
    expect(await reviewAction(fakeDecider(() => ({ fail: "timeout" })), RULES, ACTION, { mayAutoApprove: true })).toEqual({ kind: "ask", reason: "unavailable" });
    const slow = fakeDecider(() => ({ hang: true }));
    expect(await reviewAction(slow, RULES, ACTION, { mayAutoApprove: true, budgetMs: 60 })).toEqual({ kind: "ask", reason: "unavailable" });
    expect(await reviewAction(undefined, RULES, ACTION, { mayAutoApprove: true })).toEqual({ kind: "ask", reason: "unavailable" });
  });

  it("describes the action in the person's words and offers each rule by number", async () => {
    const decider = fakeDecider(script(null, null));
    await reviewAction(decider, RULES, ACTION, { mayAutoApprove: true });
    const call = decider.calls[0]!;
    expect(call.seam).toBe("autoReview");
    expect(call.state).toEqual(reviewState(ACTION));
    expect(call.questions.allowed_by).toMatchObject({ type: "choice", options: { none: expect.any(String), rule_1: RULES.allow[0], rule_2: RULES.allow[1] } });
    expect(call.questions.blocked_by).toMatchObject({ options: { none: expect.any(String), rule_1: RULES.block[0] } });
    expect(call.options.timeoutMs).toBe(1_500);
  });

  it("keeps long details short", () => {
    const state = reviewState({ tool: "Bash", summary: "x".repeat(5_000), command: `y\n${"z".repeat(5_000)}` });
    expect(state.action.details.length).toBe(600);
    expect(state.action.command!.length).toBe(600);
  });
});

type Opened = Extract<RuntimeEvent, { type: "request.opened" }>;

function opened(requestId = "r1", over: Partial<Opened> = {}): Opened {
  return {
    eventId: `e-${requestId}`, threadId: "t1", createdAt: "now", provider: "claude", type: "request.opened",
    requestType: "permission", requestId, tool: "Bash", summary: "run pnpm test", command: { command: "pnpm test", cwd: "/p" },
    ...over,
  } as Opened;
}

function harness(replies: FakeScript, over: Partial<AutoReviewDeps> = {}, rules = RULES) {
  const decider = fakeDecider(replies);
  const delivered: RuntimeEvent[] = [];
  const notes: Array<{ text: string; ok: boolean }> = [];
  const records: Array<{ decision: string; rule: string }> = [];
  const answers: Array<{ behavior: string; message?: string }> = [];
  const review = createAutoReview({
    decider,
    enabled: () => true,
    rules: () => rules,
    context: () => ({ botId: "b1", botName: "Maya", mayAutoApprove: true }),
    deliver: (event) => { delivered.push(event); },
    answer: async (_event, behavior, message) => {
      answers.push({ behavior, message });
      return (behavior === "allow" ? "allowed-once" : "rejected") as RequestOutcome;
    },
    note: (_event, text, ok) => { notes.push({ text, ok }); },
    record: (_event, decision, rule) => { records.push({ decision, rule }); },
    ...over,
  });
  return { review, decider, delivered, notes, records, answers };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("createAutoReview", () => {
  it("approves quietly when a rule clearly allows the action: no card, a grey line, a record", async () => {
    const h = harness(script(["rule_2", 0.98], null));
    expect(h.review.intercept(opened())).toBe(true);
    await settled();
    expect(h.answers).toEqual([{ behavior: "allow", message: undefined }]);
    expect(h.notes).toEqual([{ text: "Auto-approved by your rule: Running the test suite is fine.", ok: true }]);
    expect(h.records).toEqual([{ decision: "auto-approved", rule: "Running the test suite is fine." }]);
    expect(h.delivered).toHaveLength(0);
    expect(h.review.pending()).toBe(0);
  });

  it("pauses the action and says why when a rule blocks it", async () => {
    const h = harness(script(null, ["rule_1", 0.95]));
    h.review.intercept(opened("r2", { summary: "rm -rf ~/Documents" }));
    await settled();
    expect(h.answers[0]!.behavior).toBe("deny");
    expect(h.answers[0]!.message).toContain("Never delete anything outside the project folder.");
    expect(h.notes).toEqual([{ text: "Paused by your rule: Never delete anything outside the project folder.", ok: false }]);
    expect(h.records[0]!.decision).toBe("auto-denied");
    expect(h.delivered).toHaveLength(0);
  });

  it("hands the event back unchanged when it is not sure, so the card shows as today", async () => {
    const h = harness(script(["rule_1", 0.6], null));
    const event = opened();
    h.review.intercept(event);
    await settled();
    expect(h.delivered).toEqual([event]);
    expect(h.answers).toHaveLength(0);
    expect(h.review.intercept(event)).toBe(false);
  });

  it("shows the card when the decider fails or the answer cannot be delivered", async () => {
    const down = harness(() => ({ fail: "unreachable" }));
    down.review.intercept(opened());
    await settled();
    expect(down.delivered).toHaveLength(1);
    const undeliverable = harness(script(["rule_1", 0.99], null), { answer: async () => "unavailable" });
    undeliverable.review.intercept(opened());
    await settled();
    expect(undeliverable.delivered).toHaveLength(1);
    expect(undeliverable.notes).toHaveLength(0);
  });

  it("leaves everything else alone: questions, no rules, switched off, unknown dogs", () => {
    const h = harness(script(["rule_1", 0.99], null));
    expect(h.review.intercept(opened("q", { requestType: "question" }))).toBe(false);
    expect(h.review.intercept(opened("q2", { questions: [{ question: "?" }] } as Partial<Opened>))).toBe(false);
    expect(h.review.intercept(opened("", {}))).toBe(false);
    expect(h.review.intercept({ ...opened(), type: "turn.started" } as unknown as RuntimeEvent)).toBe(false);
    const empty = harness(script(["rule_1", 0.99], null), {}, { allow: [], block: [] });
    expect(empty.review.intercept(opened())).toBe(false);
    const off = harness(script(["rule_1", 0.99], null), { enabled: () => false });
    expect(off.review.intercept(opened())).toBe(false);
    const stranger = harness(script(["rule_1", 0.99], null), { context: () => null });
    expect(stranger.review.intercept(opened())).toBe(false);
    expect(h.decider.calls).toHaveLength(0);
  });

  it("never auto-approves what must always ask, but can still pause it", async () => {
    const h = harness(script(["rule_1", 0.99], ["rule_1", 0.99]), { context: () => ({ mayAutoApprove: false }) });
    h.review.intercept(opened());
    await settled();
    expect(h.answers.map((answer) => answer.behavior)).toEqual(["deny"]);
    const allowOnly = harness(script(["rule_1", 0.99], null), { context: () => ({ mayAutoApprove: false }) }, { allow: RULES.allow, block: [] });
    const event = opened();
    expect(allowOnly.review.intercept(event)).toBe(true);
    await settled();
    expect(allowOnly.answers).toHaveLength(0);
    expect(allowOnly.delivered).toEqual([event]);
  });

  it("drops a held request that resolves meanwhile, and releases it when the turn ends", async () => {
    const slow: FakeScript = () => ({ answers: { allowed_by: choiceAnswer("rule_1", 0.99, ["none", "rule_1"]) }, delayMs: 30 });
    const dropped = harness(slow);
    dropped.review.intercept(opened("r9"));
    dropped.review.intercept({ eventId: "x", threadId: "t1", createdAt: "now", provider: "claude", type: "request.resolved", requestId: "r9", behavior: "deny", source: "timeout" } as RuntimeEvent);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(dropped.answers).toHaveLength(0);
    expect(dropped.delivered).toHaveLength(0);
    const ended = harness(slow);
    const event = opened("r10");
    ended.review.intercept(event);
    ended.review.intercept({ eventId: "y", threadId: "t1", createdAt: "now", provider: "claude", type: "turn.completed", ok: true } as RuntimeEvent);
    expect(ended.delivered).toEqual([event]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ended.answers).toHaveLength(0);
  });

  it("does not throw when the recorder or decider misbehave", async () => {
    const spy = vi.fn();
    const h = harness(() => { throw new Error("boom"); }, { deliver: spy });
    h.review.intercept(opened());
    await settled();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
