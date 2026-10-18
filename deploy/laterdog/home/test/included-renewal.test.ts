import { describe, expect, it } from "vitest";
import { INCLUDED_RENEW_MS, grantedAsHome, includedKeyDue } from "../src/included.ts";

const CREATED = 1_800_000_000_000;

describe("a home's free-AI key", () => {
  it("is asked for when the home has none yet", () => {
    expect(includedKeyDue({ createdAt: CREATED }, CREATED)).toBe(true);
  });

  it("is kept until 80 days, then renewed before the 90-day grant runs out", () => {
    const granted = { createdAt: CREATED, includedKey: "ldt_x", includedAt: CREATED, includedHome: true as const };
    expect(includedKeyDue(granted, CREATED + INCLUDED_RENEW_MS - 1)).toBe(false);
    expect(includedKeyDue(granted, CREATED + INCLUDED_RENEW_MS)).toBe(true);
    expect(INCLUDED_RENEW_MS).toBeLessThan(90 * 24 * 60 * 60_000);
  });

  it("dates older homes' keys from when the home was made", () => {
    expect(includedKeyDue({ createdAt: CREATED, includedKey: "ldt_x", includedHome: true }, CREATED + INCLUDED_RENEW_MS)).toBe(true);
    expect(includedKeyDue({ createdAt: CREATED, includedKey: "ldt_x", includedHome: true }, CREATED + 1)).toBe(false);
  });

  it("is asked for once more when it was granted before the computers service knew it was a home's", () => {
    expect(includedKeyDue({ createdAt: CREATED, includedKey: "ldt_x", includedAt: CREATED }, CREATED + 1)).toBe(true);
  });

  it("counts as a home's only when the computers service says so", async () => {
    expect(await grantedAsHome(Response.json({ trial: { state: "active" }, home: true }))).toBe(true);
    expect(await grantedAsHome(Response.json({ trial: { state: "active" } }))).toBe(false);
    expect(await grantedAsHome(new Response("not json"))).toBe(false);
  });
});
