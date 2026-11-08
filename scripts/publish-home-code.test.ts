import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { releaseLabel, stillCurrent } from "./publish-home-code.mjs";

describe("publishing main to every Cloud home", () => {
  it("names the release after the main commit", () => {
    expect(releaseLabel("1785de9ebcdef0123", "Let any dog fix another dog")).toBe("main 1785de9eb Let any dog fix another dog");
  });

  it("only points homes at a build of the newest main, so a slow older run never wins", () => {
    expect(stillCurrent("abc", "abc")).toBe(true);
    expect(stillCurrent("abc", "def")).toBe(false);
    expect(stillCurrent("", "")).toBe(false);
  });

  it("has no GitHub workflow; Jacob's Mac publishes the home", () => {
    expect(existsSync(new URL("../.github/workflows/cloud-home-code.yml", import.meta.url))).toBe(false);
  });
});
