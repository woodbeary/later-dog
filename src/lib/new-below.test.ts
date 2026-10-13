import { describe, expect, it } from "vitest";
import { newBelowCount } from "./new-below";

const rows = [
  { id: "a", role: "user" },
  { id: "b", role: "bot" },
  { id: "c", role: "user" },
  { id: "d", role: "bot" },
  { id: "e", role: "bot" },
];

describe("new messages below a scrolled-up transcript", () => {
  it("counts only replies that arrived after the person scrolled away", () => {
    expect(newBelowCount(rows, "b")).toBe(2);
    expect(newBelowCount(rows, "d")).toBe(1);
    expect(newBelowCount(rows, "e")).toBe(0);
  });

  it("counts nothing without a known place to count from", () => {
    expect(newBelowCount(rows, null)).toBe(0);
    expect(newBelowCount(rows, "gone")).toBe(0);
  });
});
