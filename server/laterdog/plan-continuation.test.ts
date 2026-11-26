import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PlanContinuations,
  filePlanContinuations,
  endedAtTurnLimit,
  type PlanContinuation,
} from "./plan-continuation.ts";
import type { PlanItem } from "../../shared/dog-plan.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const items: PlanItem[] = [{ text: "Finish the repair", status: "in_progress" }];
const turn = { botId: "dog", threadId: "thread", sourceId: "request", generation: "g1" };
const end = {
  threadId: "thread",
  turnId: "t1",
  generation: "g1",
  reason: "max_turns",
  items,
  eligible: true,
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function fixture(saved: PlanContinuation[] = []) {
  let disk = structuredClone(saved);
  const host = {
    state: vi.fn(() => "ready" as "ready" | "wait" | "cancel"),
    start: vi.fn(async (_entry: PlanContinuation, _prompt: string) => {}),
    blocked: vi.fn(() => false),
    notice: vi.fn(),
    changed: vi.fn(),
    failed: vi.fn(),
  };
  const ledger = {
    read: () => structuredClone(disk),
    write: (entries: PlanContinuation[]) => {
      disk = structuredClone(entries);
    },
  };
  const queue = new PlanContinuations(ledger, host);
  queue.begin(turn, items);
  return { queue, host, ledger, disk: () => disk };
}

describe("turn limits", () => {
  it.each([
    "max_turns",
    "error_max_turns",
    "max_tokens",
    "max_output_tokens",
    "context_length_exceeded",
    "model_context_window_exceeded",
    "tool_call_limit",
    "length",
  ])("recognizes %s", (reason) => {
    expect(endedAtTurnLimit(reason)).toBe(true);
  });
  it.each([
    "The prompt is too long",
    "Context window exceeded",
    "Stopped after 200 tool calls without a final answer",
    "model-call limit reached",
  ])("recognizes a terminal failure: %s", (failure) => {
    expect(endedAtTurnLimit("error", failure)).toBe(true);
  });
  it.each([
    "usage_limit",
    "auth_required",
    "provider_safety",
    "interrupted",
    "cancelled",
    "update_required",
  ])("respects %s even with an earlier context error", (reason) => {
    expect(endedAtTurnLimit(reason, "prompt is too long")).toBe(false);
  });
  it.each([
    "Network timeout",
    "Tool response exceeded the size limit",
    "Monthly usage limit reached",
    "Permission denied",
    "end_turn",
  ])("leaves other endings alone: %s", (reason) => {
    expect(endedAtTurnLimit(reason)).toBe(false);
  });
});

describe("saved plan continuation", () => {
  it("persists before dispatch, coalesces duplicate endings and uses the same request", async () => {
    const f = fixture();
    expect(f.queue.end(end)).toBe(true);
    expect(f.queue.end(end)).toBe(false);
    expect(f.disk()[0]).toMatchObject({ sourceId: "request", pending: true, attempts: 1 });
    f.queue.drain();
    f.queue.drain();
    expect(f.host.start).toHaveBeenCalledTimes(1);
    expect(f.host.start.mock.calls[0][0]).toMatchObject({
      threadId: "thread",
      sourceId: "request",
    });
    await flush();
  });
  it.each([
    { eligible: false },
    { items: [] },
    { items: [{ text: "Finished", status: "done" as const }] },
    { reason: "interrupted" },
    { reason: "end_turn" },
  ])("does not resume an ineligible ending %j", (patch) => {
    const f = fixture();
    expect(f.queue.end({ ...end, ...patch })).toBe(false);
    f.queue.drain();
    expect(f.host.start).not.toHaveBeenCalled();
  });
  it("retains pending work across a restart and waits for admission", () => {
    const f = fixture();
    f.queue.end(end);
    const restored = new PlanContinuations(f.ledger, f.host);
    f.host.state.mockReturnValue("wait");
    restored.drain();
    expect(restored.pending("thread")).toBe(true);
    expect(f.host.start).not.toHaveBeenCalled();
    f.host.state.mockReturnValue("ready");
    restored.drain();
    expect(f.host.start).toHaveBeenCalledTimes(1);
  });
  it("retains the recovery obligation if the successor crashes during setup", () => {
    const f = fixture();
    f.queue.end(end);
    f.queue.begin({ ...turn, generation: "g2" }, items);
    expect(f.queue.pending("thread")).toBe(false);
    const restored = new PlanContinuations(f.ledger, f.host);
    expect(restored.pending("thread")).toBe(true);
    restored.drain();
    expect(f.host.start).toHaveBeenCalledOnce();
  });
  it("ignores a completed turn from an older dispatch generation", () => {
    const f = fixture();
    f.queue.end(end);
    f.queue.begin({ ...turn, generation: "g2" }, items);
    expect(f.queue.end(end)).toBe(false);
    expect(f.queue.get("thread")?.generation).toBe("g2");
    expect(f.queue.get("thread")?.attempts).toBe(1);
  });
  it("cancellation removes pending work before it can dispatch", () => {
    const f = fixture();
    f.queue.end(end);
    f.queue.cancel("thread");
    f.queue.drain();
    expect(f.disk()).toEqual([]);
    expect(f.host.start).not.toHaveBeenCalled();
  });
  it("a newer request cancels a saved continuation", () => {
    const f = fixture();
    f.queue.end(end);
    f.host.state.mockReturnValue("cancel");
    f.queue.drain();
    expect(f.queue.pending("thread")).toBe(false);
    expect(f.host.start).not.toHaveBeenCalled();
  });
  it("retries a transient admission failure without losing the saved request", async () => {
    const f = fixture();
    f.queue.end(end);
    f.host.blocked.mockReturnValue(true);
    f.host.start.mockRejectedValueOnce(new Error("busy"));
    f.queue.drain();
    await flush();
    f.queue.drain();
    await flush();
    expect(f.host.start).toHaveBeenCalledTimes(2);
    expect(f.host.failed).not.toHaveBeenCalled();
  });
  it("reports a real dispatch failure and stops claiming it is working", async () => {
    const f = fixture();
    f.queue.end(end);
    f.host.start.mockRejectedValue(new Error("account unavailable"));
    f.queue.drain();
    await flush();
    expect(f.queue.pending("thread")).toBe(false);
    expect(f.host.failed).toHaveBeenCalledOnce();
    expect(f.host.notice.mock.calls.at(-1)?.[1]).toContain("account unavailable");
  });
  it("continues beyond three unchanged completed-step checkpoints and twenty turns while reopening its file ledger", async () => {
    const f = fixture();
    const dir = mkdtempSync(join(tmpdir(), "plan-continuation-restart-"));
    const path = join(dir, "continuations.json");
    const reopen = () => new PlanContinuations(filePlanContinuations(path), f.host);
    try {
      let queue = reopen();
      for (let n = 0; n < 24; n++) {
        queue.begin({ ...turn, generation: `g${n}` }, items);
        expect(queue.end({ ...end, generation: `g${n}`, turnId: `t${n}` })).toBe(true);
        expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([
          expect.objectContaining({
            sourceId: "request",
            attempts: n + 1,
            stalled: n,
            pending: true,
          }),
        ]);
        queue = reopen();
        expect(queue.get("thread")).toMatchObject({
          sourceId: "request",
          attempts: n + 1,
          stalled: n,
          pending: true,
        });
        queue.drain();
        queue.drain();
        expect(f.host.start).toHaveBeenCalledTimes(n + 1);
        await flush();
        queue = reopen();
      }
      expect(queue.pending("thread")).toBe(true);
      expect(f.host.notice.mock.calls.every(([, , ok]) => ok)).toBe(true);
      expect(f.host.failed).not.toHaveBeenCalled();
      queue.begin({ ...turn, generation: "finished" }, items);
      expect(
        queue.end({
          ...end,
          generation: "finished",
          turnId: "final",
          reason: "end_turn",
          items: [{ ...items[0]!, status: "done" }],
        }),
      ).toBe(false);
      expect(reopen().get("thread")).toBeUndefined();
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([]);
    } finally {
      await removeTempDir(dir);
    }
  });
  it("continues beyond twenty turns while completed steps reset only the diagnostic stall count", () => {
    const f = fixture();
    let queue = f.queue;
    for (let n = 0; n < 24; n++) {
      const updated: PlanItem[] = [{ text: `Completed ${n}`, status: "done" }, ...items];
      queue.begin({ ...turn, generation: `g${n}` }, updated);
      expect(queue.end({ ...end, generation: `g${n}`, turnId: `t${n}`, items: updated })).toBe(
        true,
      );
      queue = new PlanContinuations(f.ledger, f.host);
      expect(queue.get("thread")).toMatchObject({ attempts: n + 1, stalled: 0, pending: true });
    }
    queue.cancel("thread");
    queue.drain();
    expect(f.host.start).not.toHaveBeenCalled();
    expect(new PlanContinuations(f.ledger, f.host).pending("thread")).toBe(false);
  });
  it("a new request resets the continuation diagnostics", () => {
    const f = fixture();
    f.queue.end(end);
    f.queue.begin({ ...turn, sourceId: "new-request", generation: "g2" }, items);
    expect(f.queue.get("thread")).toMatchObject({
      attempts: 0,
      stalled: 0,
      sourceId: "new-request",
    });
  });
});
