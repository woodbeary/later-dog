import { expect, it } from "vitest";
import { createPlacedThreads, preToolGuardDecision } from "./placed-threads.ts";

it("holds a chat while any of its engines is on a computer, and releases each engine once", () => {
  const placed = createPlacedThreads();
  expect(placed.has("t1")).toBe(false);
  const first = placed.place("t1");
  const second = placed.place("t1");
  expect(placed.has("t1")).toBe(true);
  expect(placed.has("t2")).toBe(false);
  first();
  first();
  expect(placed.has("t1")).toBe(true);
  second();
  expect(placed.has("t1")).toBe(false);
});

it("skips only the home's disk and heavy-command guards for a chat whose engine is on its computer", () => {
  const placed = createPlacedThreads();
  const calls: string[] = [];
  const guards = (answers: Partial<Record<"signal" | "homeDisk" | "homeHeavy" | "alwaysAsk", string>>) => ({
    signal: () => { calls.push("signal"); return answers.signal ?? null; },
    homeDisk: () => { calls.push("homeDisk"); return answers.homeDisk ?? null; },
    homeHeavy: () => { calls.push("homeHeavy"); return answers.homeHeavy ?? null; },
    alwaysAsk: () => { calls.push("alwaysAsk"); return answers.alwaysAsk ?? null; },
  });
  expect(preToolGuardDecision("t1", guards({ homeDisk: "deny disk", alwaysAsk: "ask" }), placed)).toBe("deny disk");
  expect(preToolGuardDecision("t1", guards({ homeHeavy: "deny heavy" }), placed)).toBe("deny heavy");
  const release = placed.place("t1");
  calls.length = 0;
  expect(preToolGuardDecision("t1", guards({ homeDisk: "deny disk", homeHeavy: "deny heavy", alwaysAsk: "ask" }), placed)).toBe("ask");
  expect(calls).toEqual(["signal", "alwaysAsk"]);
  expect(preToolGuardDecision("t1", guards({ signal: "deny signal", alwaysAsk: "ask" }), placed)).toBe("deny signal");
  expect(preToolGuardDecision("t1", guards({ homeDisk: "deny disk" }), placed)).toBeNull();
  release();
  expect(preToolGuardDecision("t1", guards({ homeDisk: "deny disk" }), placed)).toBe("deny disk");
});
