import { describe, expect, it, vi } from "vitest";

import type { SteerOutcome } from "../contracts.ts";
import type { Message } from "../store.ts";
import { sendQueuedAsNextTurn, steerWhileRunning, stillBlockedReason, stillStoppingReason, type NextTurnSend } from "./queued-steer.ts";

const fast = { stopMs: 200, settleMs: 200, pollMs: 5 };

function thread(options: { busy: boolean; queued: string[]; stops?: "ends" | "stuck" | "hangs" | "throws"; drains?: number }) {
  const state = { busy: options.busy, queued: [...options.queued], chat: [] as Message[] };
  const drainCount = options.drains ?? Number.POSITIVE_INFINITY;
  const drain = vi.fn(() => {
    if (state.busy) return;
    const started = state.queued.splice(0, drainCount);
    for (const queueId of started) {
      state.chat.push({ id: `m-${queueId}`, role: "user", kind: "text", text: queueId, at: state.chat.length, queueId } as Message);
    }
    if (started.length) state.busy = true;
  });
  const interrupt = vi.fn(async () => {
    if (options.stops === "hangs") return new Promise<void>(() => {});
    if (options.stops === "throws") {
      state.busy = false;
      throw new Error("the engine said no");
    }
    if (options.stops !== "stuck") setTimeout(() => { state.busy = false; }, 20);
  });
  const send: NextTurnSend = {
    threadId: "thread",
    name: "coordinator",
    queueIds: options.queued,
    busy: () => state.busy,
    waiting: (queueId) => state.queued.includes(queueId),
    interrupt,
    drain,
    messages: () => [{ id: "earlier", role: "user", kind: "text", text: "first", at: -1 } as Message, ...state.chat],
  };
  return { send, state, drain, interrupt };
}

describe("sending a queued message as the next turn", () => {
  it("starts it at once when nothing is running, without stopping anything", async () => {
    const { send, interrupt, drain } = thread({ busy: false, queued: ["q1"] });
    const receipt = await sendQueuedAsNextTurn(send, fast);
    expect(receipt).toMatchObject({ ok: true, sent: true, interrupted: false, threadId: "thread", queueIds: ["q1"] });
    expect("messages" in receipt && receipt.messages.map((message) => message.id)).toEqual(["m-q1"]);
    expect(interrupt).not.toHaveBeenCalled();
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("stops the running turn, then sends the message as the next turn exactly once", async () => {
    const { send, interrupt, drain, state } = thread({ busy: true, queued: ["q1"], stops: "ends" });
    const receipt = await sendQueuedAsNextTurn(send, fast);
    expect(receipt).toMatchObject({ sent: true, interrupted: true, queueIds: ["q1"] });
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(state.chat.filter((message) => message.queueId === "q1")).toHaveLength(1);
  });

  it("still sends the message when stopping reported an error but the turn ended", async () => {
    const { send } = thread({ busy: true, queued: ["q1"], stops: "throws" });
    await expect(sendQueuedAsNextTurn(send, fast)).resolves.toMatchObject({ sent: true, interrupted: true });
  });

  it("names the stuck turn in one plain line and keeps the message queued", async () => {
    const { send, drain, state } = thread({ busy: true, queued: ["q1"], stops: "stuck" });
    const receipt = await sendQueuedAsNextTurn(send, fast);
    expect(receipt).toEqual({ ok: true, queued: true, threadId: "thread", reason: stillStoppingReason("coordinator") });
    expect(drain).not.toHaveBeenCalled();
    expect(state.queued).toEqual(["q1"]);
  });

  it("gives up waiting on a stop that never returns", async () => {
    const { send } = thread({ busy: true, queued: ["q1"], stops: "hangs" });
    const started = Date.now();
    const receipt = await sendQueuedAsNextTurn(send, fast);
    expect(receipt).toMatchObject({ queued: true, reason: stillStoppingReason("coordinator") });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("says plainly when the dog is free but cannot take the message yet", async () => {
    const { send } = thread({ busy: false, queued: ["q1"], drains: 0 });
    const started = Date.now();
    const receipt = await sendQueuedAsNextTurn(send, { ...fast, settleMs: 5_000 });
    expect(receipt).toEqual({ ok: true, queued: true, threadId: "thread", reason: stillBlockedReason("coordinator") });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reports only the queued messages that went out with the next turn", async () => {
    const { send } = thread({ busy: true, queued: ["q1", "q2"], stops: "ends", drains: 1 });
    const receipt = await sendQueuedAsNextTurn(send, fast);
    expect(receipt).toMatchObject({ sent: true, queueIds: ["q1"] });
    expect("messages" in receipt && receipt.messages.map((message) => message.queueId)).toEqual(["q1"]);
  });
});

describe("steering a queued message into the running turn", () => {
  const quick = { attempts: 4, delayMs: 5 };

  it("tries again while the turn is still starting, and takes the first yes", async () => {
    const answers: SteerOutcome[] = ["refused", "refused", "steered"];
    const steer = vi.fn(async () => answers.shift() ?? "refused");
    await expect(steerWhileRunning(steer, () => true, quick)).resolves.toBe("steered");
    expect(steer).toHaveBeenCalledTimes(3);
  });

  it("stops asking once the turn has ended", async () => {
    const steer = vi.fn(async (): Promise<SteerOutcome> => "refused");
    await expect(steerWhileRunning(steer, () => false, quick)).resolves.toBe("refused");
    expect(steer).toHaveBeenCalledTimes(1);
  });

  it("gives up after a few refusals so the turn can be stopped instead", async () => {
    const steer = vi.fn(async (): Promise<SteerOutcome> => "refused");
    await expect(steerWhileRunning(steer, () => true, quick)).resolves.toBe("refused");
    expect(steer).toHaveBeenCalledTimes(4);
  });

  it("treats an engine error as maybe delivered, never as a refusal to retry", async () => {
    const steer = vi.fn(async (): Promise<SteerOutcome> => { throw new Error("pipe closed"); });
    await expect(steerWhileRunning(steer, () => true, quick)).resolves.toBe("indeterminate");
    expect(steer).toHaveBeenCalledTimes(1);
  });
});
