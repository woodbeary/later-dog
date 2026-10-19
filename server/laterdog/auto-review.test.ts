import { describe, expect, it } from "vitest";
import { routineApply } from "../direct-apply.ts";
import { autoReviewFromDogs, autoReviewOn, ownerTurnMode } from "./auto-review.ts";

describe("the Auto-review switch", () => {
  it("is on unless it was turned off", () => {
    expect(autoReviewOn(undefined)).toBe(true);
    expect(autoReviewOn({})).toBe(true);
    expect(autoReviewOn({ autoReview: true })).toBe(true);
    expect(autoReviewOn({ autoReview: false })).toBe(false);
  });

  it("starts off once on a Cloud home whose dogs already worked Off-leash, and on otherwise", () => {
    expect(autoReviewFromDogs([], true)).toBe(true);
    expect(autoReviewFromDogs([{ approvalMode: "ask" }, { approvalMode: "full" }], true)).toBe(true);
    expect(autoReviewFromDogs([{ approvalMode: "ask" }, { approvalMode: "auto" }], true)).toBe(false);
    expect(autoReviewFromDogs([{ autoApprove: true }], true)).toBe(false);
    expect(autoReviewFromDogs([{ approvalMode: "ask", autoApprove: true }], true)).toBe(true);
  });

  it("starts on for a Mac install, where Off-leash dogs already had the engine's reviewer and cards", () => {
    expect(autoReviewFromDogs([], false)).toBe(true);
    expect(autoReviewFromDogs([{ approvalMode: "auto" }], false)).toBe(true);
    expect(autoReviewFromDogs([{ autoApprove: true }, { approvalMode: "ask" }], false)).toBe(true);
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
