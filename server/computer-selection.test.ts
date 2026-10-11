import { describe, expect, it } from "vitest";

import { pickComputer, type ComputerOption } from "./computer-selection.ts";

const option = (surface: ComputerOption["surface"], state: "ready" | "asleep" | "missing" | "off"): ComputerOption => ({
  surface,
  available: state !== "off",
  ready: state === "ready",
  canStart: state === "asleep",
  canCreate: state === "missing",
});

describe("which computer select_computer picks", () => {
  const offered = (cloud: "asleep" | "missing") => [option("cloud", cloud), option("local", "ready")];

  it("keeps the cloud computer this turn starts on its first call: asking for it or for Auto never moves the request", () => {
    for (const cloud of ["asleep", "missing"] as const) {
      for (const requested of ["cloud", "auto"] as const) {
        const picked = pickComputer(offered(cloud), requested, "cloud", true);
        expect(picked.option?.surface).toBe("cloud");
        expect(picked.current).toBe(true);
      }
    }
  });

  it("switches away from a current computer that is not up and not this turn's to start", () => {
    const auto = pickComputer(offered("asleep"), "auto", "cloud", false);
    expect(auto.option?.surface).toBe("local");
    expect(auto.current).toBe(false);
    const cloud = pickComputer(offered("asleep"), "cloud", "cloud", false);
    expect(cloud.option?.surface).toBe("cloud");
    expect(cloud.current).toBe(false);
  });

  it("keeps a ready current computer, and moves to another when asked", () => {
    const options = [option("cloud", "ready"), option("local", "ready")];
    expect(pickComputer(options, "auto", "cloud", false)).toMatchObject({ option: { surface: "cloud" }, current: true });
    expect(pickComputer(options, "local", "cloud", true)).toMatchObject({ option: { surface: "local" }, current: false });
  });

  it("on Auto with nothing current prefers anything ready, then one it can start or create", () => {
    expect(pickComputer([option("cloud", "asleep"), option("local", "ready")], "auto", "off", false).option?.surface).toBe("local");
    expect(pickComputer([option("cloud", "missing"), option("local", "off")], "auto", "off", false).option?.surface).toBe("cloud");
    expect(pickComputer([option("local", "off"), option("cloud", "asleep")], "auto", "off", false).option?.surface).toBe("cloud");
    expect(pickComputer([option("cloud", "off")], "auto", "off", false).option).toBeUndefined();
  });
});
