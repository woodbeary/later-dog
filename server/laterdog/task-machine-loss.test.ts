import { describe, expect, it } from "vitest";
import { LOSS_NOTE, taskMachineLoss } from "./task-machine-loss.ts";

function host(busyFor = 0) {
  let clock = 0;
  let busy = busyFor;
  const started: string[] = [];
  const notes: string[] = [];
  return {
    started, notes,
    busy: () => busy-- > 0,
    request: () => "m1",
    start: async (_bot: string, thread: string, prompt: string) => { started.push(`${thread}:${prompt === LOSS_NOTE}`); },
    note: (_thread: string, text: string) => { notes.push(text); },
    now: () => clock,
    wait: async (ms: number) => { clock += ms; },
    advance: (ms: number) => { clock += ms; },
  };
}

describe("picking a task up after its machine is lost", () => {
  it("waits for the stopped turn to settle, then carries on with a note, at most three times an hour", async () => {
    const h = host(3);
    const pickUp = taskMachineLoss(h);
    expect(await pickUp("dog", "t1", "cmp_a")).toBe("started");
    expect(h.started).toEqual(["t1:true"]);
    expect(await pickUp("dog", "t1", "cmp_a")).toBe("started");
    expect(await pickUp("dog", "t1", "cmp_a")).toBe("started");
    expect(await pickUp("dog", "t1", "cmp_a")).toBe("gave_up");
    expect(h.notes.at(-1)).toContain("4 times within an hour");
    h.advance(61 * 60_000);
    expect(await pickUp("dog", "t1", "cmp_a")).toBe("started");
  });

  it("leaves a turn alone that is still busy after five minutes", async () => {
    const h = host(1_000);
    expect(await taskMachineLoss(h)("dog", "t1", "cmp_a")).toBe("busy");
    expect(h.started).toEqual([]);
  });
});
