import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOWS = new URL("../.github/workflows/", import.meta.url);
const triggers = (name: string) => parse(readFileSync(new URL(name, WORKFLOWS), "utf8")).on;

describe("GitHub workflows run only where later.dog needs them", () => {
  it("keeps the set of workflows to CI, the Cloud home images and Worker, and the macOS build", () => {
    expect(readdirSync(WORKFLOWS).sort()).toEqual(["ci.yml", "cloud-home-delta-image.yml", "cloud-home-image.yml", "cloud-home-worker.yml", "macos.yml"]);
  });

  it("runs CI on pull requests and on pushes to main only", () => {
    const on = triggers("ci.yml");
    expect(Object.keys(on).sort()).toEqual(["pull_request", "push"]);
    expect(on.push).toEqual({ branches: ["main"] });
  });

  it("builds the Cloud home image only when someone runs it by hand", () => {
    expect(triggers("cloud-home-image.yml")).toEqual({ workflow_dispatch: null });
  });

  it("builds the Cloud home delta image only when someone runs it by hand", () => {
    expect(Object.keys(triggers("cloud-home-delta-image.yml"))).toEqual(["workflow_dispatch"]);
  });

  it("deploys the Cloud home Worker only when someone runs it by hand, leaving its containers and image alone", () => {
    expect(triggers("cloud-home-worker.yml")).toEqual({ workflow_dispatch: null });
    const deploys = readFileSync(new URL("cloud-home-worker.yml", WORKFLOWS), "utf8").split("\n").filter((line) => line.includes("wrangler deploy"));
    expect(deploys).toHaveLength(1);
    expect(deploys[0]).toContain("--containers-rollout=none");
  });
});
