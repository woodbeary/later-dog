import { describe, expect, it } from "vitest";
import { machinesSummary } from "./MachinesPanel";

describe("the machines summary", () => {
  it("says how many machines run, are busy and are large, and how many tasks wait", () => {
    const line = { settings: { cap: 3, idleMinutes: 5 }, max: 100, running: [{ id: "a", size: "large" as const, busy: true }, { id: "b", size: "small" as const, busy: false }, { id: "c", size: "small" as const, busy: true }], waiting: [{ id: "w1" }, { id: "w2" }] };
    expect(machinesSummary(line)).toBe("3 running, 2 busy, 1 large · 2 waiting");
  });

  it("says nothing runs when the line is empty or unknown", () => {
    expect(machinesSummary(undefined)).toBe("No machines running");
    expect(machinesSummary({ settings: { cap: 20, idleMinutes: 5 }, max: 100, running: [], waiting: [] })).toBe("No machines running");
  });
});
