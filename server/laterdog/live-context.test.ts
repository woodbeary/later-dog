import { describe, expect, it } from "vitest";
import { LIVE_CONTEXT_EVERY_MS, LiveContext } from "./live-context.ts";

describe("the context size a chat shows while a turn runs", () => {
  it("passes the first reading, then one a step bigger at most every ten seconds", () => {
    let now = 0;
    const live = new LiveContext(() => now);
    expect(live.due("t1", 100_000)).toBe(true);
    now += 1_000;
    expect(live.due("t1", 180_000)).toBe(false);
    now += LIVE_CONTEXT_EVERY_MS;
    expect(live.due("t1", 101_000)).toBe(false);
    expect(live.due("t1", 180_000)).toBe(true);
    expect(live.due("t2", 50_000)).toBe(true);
  });

  it("ignores readings with no size, and starts over for a chat's next turn", () => {
    let now = 0;
    const live = new LiveContext(() => now);
    expect(live.due("t1", undefined)).toBe(false);
    expect(live.due("t1", 0)).toBe(false);
    expect(live.due("t1", 100_000)).toBe(true);
    live.forget("t1");
    now += 1_000;
    expect(live.due("t1", 100_500)).toBe(true);
  });
});
