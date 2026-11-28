import { describe, expect, it } from "vitest";

import { scanYielding } from "./yielding-scan.ts";

describe("scanning many chats", () => {
  it("visits every item in order and hands the server back whenever a slice of time is used up", async () => {
    let clock = 0;
    const passes: number[] = [];
    const seen: number[] = [];
    await scanYielding(Array.from({ length: 10 }, (_, i) => i), (i) => { seen.push(i); clock += 4; }, {
      sliceMs: 10, now: () => clock, pass: async () => { passes.push(seen.length); },
    });
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(passes).toEqual([3, 6, 9]);
  });

  it("lets a waiting request run during a long scan", async () => {
    const order: string[] = [];
    setImmediate(() => order.push("request"));
    await scanYielding(Array.from({ length: 6 }, (_, i) => i), (i) => { const until = performance.now() + 4; while (performance.now() < until); order.push(`chat ${i}`); }, { sliceMs: 5 });
    expect(order.indexOf("request")).toBeGreaterThan(0);
    expect(order.indexOf("request")).toBeLessThan(order.length - 1);
  });
});
