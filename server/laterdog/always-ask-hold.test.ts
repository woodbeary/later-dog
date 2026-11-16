import { describe, expect, it } from "vitest";
import { callerGone, holdForPerson, type HeldAnswer } from "./always-ask-hold.ts";

function harness(answer: Promise<HeldAnswer>, caller = new AbortController()) {
  const seen: string[] = [];
  const result = holdForPerson({
    caller: caller.signal,
    open: () => ({ requestId: "r1", answer }),
    show: (id) => seen.push(`card ${id}`),
    late: (id) => seen.push(`too late ${id}`),
    forget: (id) => seen.push(`forget ${id}`),
  });
  return { caller, seen, result };
}

describe("holding a call for the person's answer", () => {
  it("shows no card when the dog's call is already gone", async () => {
    const caller = new AbortController();
    caller.abort();
    const { seen, result } = harness(new Promise(() => {}), caller);
    expect(await result).toBe("gone");
    expect(seen).toEqual([]);
  });

  it("marks the card too late when the call hangs up while waiting", async () => {
    const { caller, seen, result } = harness(new Promise(() => {}));
    caller.abort();
    expect(await result).toBe("gone");
    expect(seen).toEqual(["card r1", "forget r1", "too late r1"]);
  });

  it("runs nothing when Allow wins but the call has gone before it would run", async () => {
    const caller = new AbortController();
    const { seen, result } = harness(Promise.resolve<HeldAnswer>("allow"), caller);
    queueMicrotask(() => caller.abort());
    expect(await result).toBe("gone");
    expect(seen).toContain("too late r1");
  });

  it("hands back the answer while the call is there", async () => {
    expect(await harness(Promise.resolve("allow")).result).toBe("allow");
    expect(await harness(Promise.resolve("deny")).result).toBe("deny");
  });

  it("tells a call that already hung up", () => {
    expect(callerGone({ destroyed: true, writableEnded: false })).toBe(true);
    expect(callerGone({ socket: { destroyed: true } })).toBe(true);
    expect(callerGone({ destroyed: false, socket: { destroyed: false } })).toBe(false);
    expect(callerGone({ destroyed: true, writableEnded: true })).toBe(false);
  });
});
