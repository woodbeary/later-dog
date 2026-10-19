import { describe, expect, it } from "vitest";
import { dogCanAct } from "./dog-can-act.ts";

describe("dogCanAct", () => {
  it("lets a hidden dog act like any other dog", () => {
    expect(dogCanAct({ id: "a", hidden: true })).toBe(true);
    expect(dogCanAct({ id: "b", hidden: false })).toBe(true);
    expect(dogCanAct({ id: "c" })).toBe(true);
  });

  it("refuses only a dog that no longer exists", () => {
    expect(dogCanAct(null)).toBe(false);
    expect(dogCanAct(undefined)).toBe(false);
  });
});
