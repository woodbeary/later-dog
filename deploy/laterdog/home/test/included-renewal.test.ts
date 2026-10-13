import { describe, expect, it } from "vitest";
import { INCLUDED_RENEW_MS, includedKeyDue } from "../src/included.ts";

const CREATED = 1_800_000_000_000;

describe("a home's free-AI key", () => {
  it("is asked for when the home has none yet", () => {
    expect(includedKeyDue({ createdAt: CREATED }, CREATED)).toBe(true);
  });

  it("is kept until 80 days, then renewed before the 90-day grant runs out", () => {
    expect(includedKeyDue({ createdAt: CREATED, includedKey: "ldt_x", includedAt: CREATED }, CREATED + INCLUDED_RENEW_MS - 1)).toBe(false);
    expect(includedKeyDue({ createdAt: CREATED, includedKey: "ldt_x", includedAt: CREATED }, CREATED + INCLUDED_RENEW_MS)).toBe(true);
    expect(INCLUDED_RENEW_MS).toBeLessThan(90 * 24 * 60 * 60_000);
  });

  it("dates older homes' keys from when the home was made", () => {
    expect(includedKeyDue({ createdAt: CREATED, includedKey: "ldt_x" }, CREATED + INCLUDED_RENEW_MS)).toBe(true);
    expect(includedKeyDue({ createdAt: CREATED, includedKey: "ldt_x" }, CREATED + 1)).toBe(false);
  });
});
