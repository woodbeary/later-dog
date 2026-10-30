import { describe, expect, it } from "vitest";
import { routineApply } from "../direct-apply.ts";
import { autoReviewOn, ownerTurnMode } from "./auto-review.ts";

describe("the Auto-review switch", () => {
  it("is off unless it was turned on", () => {
    expect(autoReviewOn(undefined)).toBe(false);
    expect(autoReviewOn({})).toBe(false);
    expect(autoReviewOn({ autoReview: false })).toBe(false);
    expect(autoReviewOn({ autoReview: true })).toBe(true);
  });

  it("puts every owner's dog under the engine's reviewer, keeping Full access and Custom", () => {
    for (const saved of ["ask", "edits", "auto"] as const) expect(ownerTurnMode(saved, true), saved).toBe("auto");
    expect(ownerTurnMode("full", true)).toBe("full");
    expect(ownerTurnMode("custom", true)).toBe("custom");
    for (const saved of ["ask", "edits", "auto", "full", "custom"] as const) expect(ownerTurnMode(saved, false), saved).toBe(saved);
  });
});

describe("a routine one of the owner's dogs sets up", () => {
  it("applies directly for any of the owner's dogs, with no card", () => {
    expect(routineApply({ direct: null, owner: true, blocked: false })).toBe("owner-auto");
    expect(routineApply({ direct: "self", owner: true, blocked: false })).toBe("self");
    expect(routineApply({ direct: "full-access", owner: false, blocked: false })).toBe("full-access");
  });

  it("still waits for a card when someone else drives the turn", () => {
    expect(routineApply({ direct: null, owner: false, blocked: false })).toBeNull();
    expect(routineApply({ direct: null, owner: true, blocked: true })).toBeNull();
  });
});
