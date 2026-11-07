import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { releaseLabel, stillCurrent } from "./publish-home-code.mjs";

describe("publishing main to every Cloud home from GitHub", () => {
  it("names the release after the main commit", () => {
    expect(releaseLabel("1785de9ebcdef0123", "Let any dog fix another dog")).toBe("main 1785de9eb Let any dog fix another dog");
  });

  it("only points homes at a build of the newest main, so a slow older run never wins", () => {
    expect(stillCurrent("abc", "abc")).toBe(true);
    expect(stillCurrent("abc", "def")).toBe(false);
    expect(stillCurrent("", "")).toBe(false);
  });

  it("runs from GitHub after main's CI passes, with no Mac involved", () => {
    const workflow = readFileSync(new URL("../.github/workflows/cloud-home-code.yml", import.meta.url), "utf8");
    expect(workflow).toContain('workflows: ["later.dog CI"]');
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("node scripts/publish-home-code.mjs");
    expect(workflow).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}");
    expect(workflow).not.toMatch(/runs-on:\s*macos/);
  });
});
