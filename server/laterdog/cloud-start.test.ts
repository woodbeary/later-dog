import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLOUD_COMPUTER_BOOT_MS, CLOUD_COMPUTER_START_MARGIN_MS, cloudComputerStartBudgetMs, passingCloudFailure, remainingStartMs, startRetryingPassingFailures, stillStarting } from "./cloud-start.ts";

const serviceDown = () => Object.assign(new Error("upstream unavailable"), { boatCode: "service_unavailable" });

function clock() {
  let at = 0;
  return { now: () => at, sleep: async (ms: number) => { at += ms; } };
}

describe("starting a cloud computer while the service is briefly down", () => {
  it("tries again instead of failing the turn", async () => {
    const time = clock();
    let tries = 0;
    const machine = await startRetryingPassingFailures(async () => {
      tries += 1;
      if (tries < 3) throw serviceDown();
      return { id: "box-1" };
    }, { deadline: 150_000, pauseMs: 5_000, ...time, passing: (error) => passingCloudFailure(error, true) });
    expect(machine).toEqual({ id: "box-1" });
    expect(tries).toBe(3);
  });

  it("gives up at the deadline with the service's own error", async () => {
    const time = clock();
    let tries = 0;
    await expect(startRetryingPassingFailures(async () => { tries += 1; throw serviceDown(); },
      { deadline: 20_000, pauseMs: 5_000, ...time, passing: (error) => passingCloudFailure(error, true) })).rejects.toThrow("upstream unavailable");
    expect(tries).toBe(4);
  });

  it("does not retry a refusal that will not pass, such as no hours left", async () => {
    let tries = 0;
    const noHours = Object.assign(new Error("no hours"), { boatCode: "hours_used" });
    await expect(startRetryingPassingFailures(async () => { tries += 1; throw noHours; },
      { deadline: 150_000, pauseMs: 5_000, ...clock(), passing: (error) => passingCloudFailure(error, true) })).rejects.toBe(noHours);
    expect(tries).toBe(1);
    expect(passingCloudFailure(Object.assign(new Error("boom"), { boatStatus: 503 }), true)).toBe(true);
    expect(passingCloudFailure("not an error", true)).toBe(false);
  });
});

describe("how long a turn waits for its cloud computer to start", () => {
  it("covers the computers service's own boot limit plus a bounded margin by default", () => {
    const service = readFileSync(new URL("../../deploy/laterdog/computers/src/computer.ts", import.meta.url), "utf8");
    const idle = readFileSync(new URL("../../deploy/laterdog/computers/src/idle.ts", import.meta.url), "utf8");
    const minute = Number(/export const MINUTE = ([\d_]+);/.exec(idle)?.[1]?.replaceAll("_", ""));
    const boot = Number(/const BOOT_TIMEOUT_MS = (\d+) \* MINUTE;/.exec(service)?.[1]) * minute;
    expect(boot).toBe(CLOUD_COMPUTER_BOOT_MS);
    expect(cloudComputerStartBudgetMs({})).toBe(CLOUD_COMPUTER_BOOT_MS + CLOUD_COMPUTER_START_MARGIN_MS);
    expect(CLOUD_COMPUTER_START_MARGIN_MS).toBeGreaterThan(0);
    expect(CLOUD_COMPUTER_START_MARGIN_MS).toBeLessThanOrEqual(60_000);
  });

  it("keeps short explicit overrides for isolated tests", () => {
    expect(cloudComputerStartBudgetMs({ LATERDOG_CLOUD_COMPUTER_START_BUDGET_MS: "20000" })).toBe(20_000);
    expect(cloudComputerStartBudgetMs({ LATERDOG_CLOUD_COMPUTER_START_BUDGET_MS: "10" })).toBe(1_000);
    expect(cloudComputerStartBudgetMs({ LATERDOG_CLOUD_COMPUTER_START_BUDGET_MS: "0" })).toBe(CLOUD_COMPUTER_BOOT_MS + CLOUD_COMPUTER_START_MARGIN_MS);
    expect(cloudComputerStartBudgetMs({ LATERDOG_CLOUD_COMPUTER_START_BUDGET_MS: "soon" })).toBe(CLOUD_COMPUTER_BOOT_MS + CLOUD_COMPUTER_START_MARGIN_MS);
  });

  it("hands the wake only what is left of the turn's budget, never nothing", () => {
    expect(remainingStartMs(10_000, 4_000)).toBe(6_000);
    expect(remainingStartMs(10_000, 12_000)).toBe(1);
  });
});

describe("which computer states may extend a joined wait", () => {
  it("only a computer confirmed to be starting", () => {
    for (const state of ["starting", "provisioning"]) expect(stillStarting(state)).toBe(true);
    for (const state of ["error", "archived", "archiving", "stopped", "running", "unknown", "", null, undefined]) expect(stillStarting(state)).toBe(false);
  });
});
