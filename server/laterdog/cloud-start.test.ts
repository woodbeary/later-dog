import { describe, expect, it } from "vitest";
import { passingCloudFailure, startRetryingPassingFailures } from "./cloud-start.ts";

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
