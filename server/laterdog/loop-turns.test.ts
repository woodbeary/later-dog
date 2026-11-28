import { describe, expect, it } from "vitest";

import { loopTurns } from "./loop-turns.ts";

describe("loop turns", () => {
  it("let one waiting turn go on per pass of the event loop, in order", async () => {
    const passes: Array<() => void> = [];
    const turn = loopTurns((run) => passes.push(run));
    const order: string[] = [];
    const started = ["a", "b", "c"].map((name) => turn().then(() => { order.push(name); }));
    expect(passes).toHaveLength(1);
    passes.shift()!();
    await Promise.resolve();
    expect(order).toEqual(["a"]);
    expect(passes).toHaveLength(1);
    passes.shift()!();
    await Promise.resolve();
    expect(order).toEqual(["a", "b"]);
    passes.shift()!();
    await Promise.all(started);
    expect(order).toEqual(["a", "b", "c"]);
    expect(passes).toHaveLength(0);
  });

  it("hands the server to waiting requests between turns", async () => {
    const turn = loopTurns();
    const seen: string[] = [];
    const turns = Array.from({ length: 3 }, (_, i) => turn().then(() => { seen.push(`turn ${i}`); const until = performance.now() + 5; while (performance.now() < until); }));
    setImmediate(() => seen.push("request"));
    await Promise.all(turns);
    expect(seen.indexOf("request")).toBeLessThan(seen.indexOf("turn 2"));
  });
});
