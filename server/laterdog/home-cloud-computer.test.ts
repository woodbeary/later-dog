import { describe, expect, it } from "vitest";

import { resolveSurface, surfacePrompt } from "../surface.ts";
import { homeCloudPlan, type HomeCloudReadiness } from "./home-cloud-computer.ts";

const cloud = resolveSurface({ destination: "cloud", browserOn: true });
const on = (cloudHome: boolean, readiness: HomeCloudReadiness, forced = false) =>
  homeCloudPlan(cloud, { cloudHome, forced, browserOn: true, readiness: () => readiness });

describe("a dog's cloud computer on a later.dog Cloud home", () => {
  it("is used as is when the home's computers key works", () => {
    expect(on(true, "ready")).toBe(cloud);
  });

  it("is left out with a plain note, not a refusal, when the home has no usable computers key yet", () => {
    const plan = on(true, "not-ready");
    expect(plan).toMatchObject({ computer: undefined, browser: true, pinned: null });
    expect(plan.note).toContain("cloud computer isn't ready yet");
    const prompt = surfacePrompt({ computer: null, browser: false }, { note: plan.note, cloudHome: true });
    expect(prompt).toContain("never claim you used it");
  });

  it("is left out with a plain note when the dog's model cannot use a computer or its computer tools are off", () => {
    expect(on(true, "model-cannot")).toMatchObject({ computer: undefined });
    expect(on(true, "model-cannot").note).toContain("can't use a computer");
    expect(on(true, "tools-off")).toMatchObject({ computer: undefined });
    expect(on(true, "tools-off").note).toContain("Access");
  });

  it("still refuses on a Mac, and for a routine or team computer that names the cloud computer", () => {
    expect(on(false, "not-ready")).toBe(cloud);
    expect(on(true, "not-ready", true)).toBe(cloud);
  });

  it("never touches a place other than the cloud computer", () => {
    const off = resolveSurface({ destination: "off", browserOn: true });
    const auto = resolveSurface({ destination: undefined, browserOn: true });
    for (const plan of [off, auto]) {
      expect(homeCloudPlan(plan, { cloudHome: true, forced: false, browserOn: true, readiness: () => "not-ready" })).toBe(plan);
    }
  });
});
