import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOWS = new URL("../.github/workflows/", import.meta.url);
const triggers = (name: string) => parse(readFileSync(new URL(name, WORKFLOWS), "utf8")).on;

describe("GitHub workflows run only where later.dog needs them", () => {
  it("keeps the set of workflows to CI, the Cloud home image and the macOS build", () => {
    expect(readdirSync(WORKFLOWS).sort()).toEqual(["ci.yml", "cloud-home-image.yml", "macos.yml"]);
  });

  it("runs CI on pull requests and on pushes to main only", () => {
    const on = triggers("ci.yml");
    expect(Object.keys(on).sort()).toEqual(["pull_request", "push"]);
    expect(on.push).toEqual({ branches: ["main"] });
  });

  it("builds the Cloud home image only when someone runs it by hand", () => {
    expect(triggers("cloud-home-image.yml")).toEqual({ workflow_dispatch: null });
  });
});
