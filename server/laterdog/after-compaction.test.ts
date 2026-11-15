import { describe, expect, it } from "vitest";

import { CARRY_MAX_BYTES, CompactionCarry, carriedSections } from "./after-compaction.ts";

const section = (id: string, text: string) => ({ id, label: id, text });

describe("what a dog is given back after the engine compacts", () => {
  it("carries only the profile and the connected apps, in order, and nothing empty", () => {
    const carried = carriedSections([section("memory", "m"), section("connected", " mail "), section("user-profile", "  "), section("user-profile", "p")]);
    expect(carried.map((item) => item.id)).toEqual(["connected", "user-profile"]);
  });

  it("cuts at a section boundary: a section that would pass the cap is left out whole, the others stay", () => {
    const big = "x".repeat(CARRY_MAX_BYTES);
    const carried = carriedSections([section("user-profile", big), section("connected", "mail is connected")]);
    expect(carried.map((item) => item.id)).toEqual(["connected"]);
    const carry = new CompactionCarry();
    carry.remember("b1", "t1", [section("user-profile", big), section("connected", "mail is connected")]);
    const text = carry.context("b1", "t1");
    expect(text).toContain("mail is connected");
    expect(text).not.toContain("xxxx");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(CARRY_MAX_BYTES);
  });
});
