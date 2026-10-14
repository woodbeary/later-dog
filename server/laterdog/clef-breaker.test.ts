import { describe, expect, it } from "vitest";

import { createBoundedMap } from "./clef-bounded.ts";
import { createBreaker } from "./clef-breaker.ts";

describe("the breaker", () => {
  it("opens after three failures in a row and closes after a minute", () => {
    let clock = 0;
    const breaker = createBreaker({ now: () => clock });
    for (let index = 0; index < 2; index++) breaker.report("job", { ok: false, reason: "timeout" });
    expect(breaker.allow("job")).toBe(true);
    breaker.report("job", { ok: false, reason: "overloaded" });
    expect(breaker.allow("job")).toBe(false);
    expect(breaker.allow("other")).toBe(true);
    clock = 59_999;
    expect(breaker.isOpen("job")).toBe(true);
    clock = 60_000;
    expect(breaker.allow("job")).toBe(true);
    breaker.report("job", { ok: false, reason: "timeout" });
    expect(breaker.allow("job")).toBe(false);
  });

  it("is reset by a success and ignores settings problems", () => {
    const breaker = createBreaker();
    breaker.report("job", { ok: false, reason: "timeout" });
    breaker.report("job", { ok: false, reason: "timeout" });
    breaker.report("job", { ok: true });
    breaker.report("job", { ok: false, reason: "timeout" });
    expect(breaker.isOpen("job")).toBe(false);
    for (let index = 0; index < 5; index++) breaker.report("job", { ok: false, reason: "no_key" });
    expect(breaker.isOpen("job")).toBe(false);
  });
});

describe("the bounded map", () => {
  it("drops the oldest entries past its size and expired ones past its age", () => {
    let clock = 0;
    const map = createBoundedMap<number>({ max: 2, ttlMs: 100, now: () => clock });
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    expect(map.get("a")).toBeUndefined();
    expect(map.size).toBe(2);
    clock = 101;
    expect(map.get("b")).toBeUndefined();
    expect(map.size).toBe(1);
  });

  it("sweeps what is no longer wanted", () => {
    const map = createBoundedMap<number>({ max: 10 });
    map.set("keep", 1);
    map.set("gone", 2);
    map.sweep((key) => key === "keep");
    expect(map.get("keep")).toBe(1);
    expect(map.get("gone")).toBeUndefined();
  });
});
