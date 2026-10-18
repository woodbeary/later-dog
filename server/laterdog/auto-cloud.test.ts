import { describe, expect, it } from "vitest";
import { mountsAutoCloud, type AutoCloudTurn } from "./auto-cloud.ts";

const AUTO: AutoCloudTurn = {
  wants: undefined,
  alreadyMounted: false,
  backend: "box",
  configured: true,
  placeRefused: false,
  engineSupportsComputer: true,
  computerToolsAllowed: true,
};

describe("an Auto dog keeps its own cloud computer within reach", () => {
  it("mounts the cloud computer when nothing else is mounted", () => {
    expect(mountsAutoCloud(AUTO)).toBe(true);
  });

  it("leaves a chosen place, Off and a mounted computer alone", () => {
    expect(mountsAutoCloud({ ...AUTO, wants: "cloud" })).toBe(false);
    expect(mountsAutoCloud({ ...AUTO, wants: "local" })).toBe(false);
    expect(mountsAutoCloud({ ...AUTO, wants: "off" })).toBe(false);
    expect(mountsAutoCloud({ ...AUTO, alreadyMounted: true })).toBe(false);
  });

  it("never offers a computer the dog cannot have", () => {
    expect(mountsAutoCloud({ ...AUTO, backend: "vps" })).toBe(false);
    expect(mountsAutoCloud({ ...AUTO, configured: false })).toBe(false);
    expect(mountsAutoCloud({ ...AUTO, placeRefused: true })).toBe(false);
    expect(mountsAutoCloud({ ...AUTO, engineSupportsComputer: false })).toBe(false);
    expect(mountsAutoCloud({ ...AUTO, computerToolsAllowed: false })).toBe(false);
  });
});
