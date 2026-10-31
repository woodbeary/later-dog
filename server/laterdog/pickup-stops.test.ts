import { describe, expect, it } from "vitest";

import { createPickupStops, keepsNewerTurn } from "./pickup-stops.ts";

describe("Stops that reach later.dog around a restart", () => {
  it("remembers which conversations the person stopped", () => {
    const stops = createPickupStops();
    expect(stops.stopped("t1")).toBe(false);
    stops.stop("t1");
    expect(stops.stopped("t1")).toBe(true);
    expect(stops.stopped("t2")).toBe(false);
  });

  it("knows a turn is the restart pickup until that turn ends", () => {
    const stops = createPickupStops();
    stops.resuming("t1");
    expect(stops.resumed("t1")).toBe(true);
    expect(stops.resumed("t2")).toBe(false);
    stops.settled("t1");
    expect(stops.resumed("t1")).toBe(false);
    stops.settled("t2");
    expect(stops.resumed("t2")).toBe(false);
  });
});

describe("whether a Stop pressed on an earlier turn leaves the running one alone", () => {
  it("keeps a turn that started after the one the person pressed Stop on", () => {
    expect(keepsNewerTurn({ seen: 1_000, running: 2_000, resumed: false })).toBe(true);
  });

  it("stops the turn the person pressed Stop on", () => {
    expect(keepsNewerTurn({ seen: 2_000, running: 2_000, resumed: false })).toBe(false);
  });

  it("stops the restart pickup of the turn the person pressed Stop on", () => {
    expect(keepsNewerTurn({ seen: 1_000, running: 2_000, resumed: true })).toBe(false);
  });

  it("stops whatever runs when the press names no turn or names a later one", () => {
    expect(keepsNewerTurn({ running: 2_000, resumed: false })).toBe(false);
    expect(keepsNewerTurn({ seen: "1000", running: 2_000, resumed: false })).toBe(false);
    expect(keepsNewerTurn({ seen: Number.NaN, running: 2_000, resumed: false })).toBe(false);
    expect(keepsNewerTurn({ seen: 3_000, running: 2_000, resumed: false })).toBe(false);
  });

  it("has nothing to keep when no turn is running", () => {
    expect(keepsNewerTurn({ seen: 1_000, resumed: false })).toBe(false);
  });
});
