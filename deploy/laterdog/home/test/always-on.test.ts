import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { alwaysOn, KEEP_UP_EVERY_S } from "../src/always-on.ts";

const OWNER = "7eaec07f-4e74-4682-81c2-d3bf10549606";
const config = (name: string) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));

describe("homes that never sleep", () => {
  it("are the accounts the deploy lists, and no one else", () => {
    expect(alwaysOn(OWNER, OWNER)).toBe(true);
    expect(alwaysOn(` ${OWNER} , not-an-account`, OWNER)).toBe(true);
    expect(alwaysOn("", OWNER)).toBe(false);
    expect(alwaysOn(undefined, OWNER)).toBe(false);
    expect(alwaysOn(OWNER, "b26c934e-da5d-426a-ade3-0dc5fcf761a8")).toBe(false);
  });

  it("check on themselves every ten minutes", () => {
    expect(KEEP_UP_EVERY_S).toBe(600);
  });

  it("keep only the owner's home awake in production, and nobody's elsewhere", () => {
    expect(config("wrangler.production.json").vars.ALWAYS_ON_ACCOUNTS).toBe(OWNER);
    for (const name of ["wrangler.jsonc", "wrangler.bootstrap.json", "wrangler.test.json"]) expect(config(name).vars.ALWAYS_ON_ACCOUNTS).toBe("");
  });
});
