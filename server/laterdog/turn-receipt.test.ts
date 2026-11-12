import { describe, expect, it } from "vitest";
import type { ExecutionEvidence } from "./execution-evidence.ts";
import { turnReceipt } from "./turn-receipt.ts";

const evidence = (over: Partial<ExecutionEvidence> = {}): ExecutionEvidence => ({
  turnId: "turn-1",
  selected: { instanceId: "engine-work", model: "big", effort: "high" },
  dispatched: { instanceId: "engine-work", model: "big", effort: "high" },
  providerInstanceId: "engine-work",
  attribution: "dispatch",
  startedAt: "2026-11-11T00:00:00.000Z",
  completedAt: "2026-11-11T00:00:05.000Z",
  durationMs: 5000,
  providerSucceeded: true,
  verification: "unverified",
  ...over,
});
const names = (id: string) => ({ "engine-work": "Work account", "engine-home": "Home account" } as Record<string, string>)[id];

describe("what actually ran a turn", () => {
  it("names the account, model and effort, and nothing else", () => {
    const receipt = turnReceipt(evidence(), names);
    expect(receipt).toEqual({ account: "Work account", instanceId: "engine-work", model: "big", effort: "high" });
    expect(Object.keys(receipt!).sort()).toEqual(["account", "effort", "instanceId", "model"]);
  });

  it("keeps what was selected only when it differs from what ran", () => {
    const moved = evidence({ dispatched: { instanceId: "engine-home", model: "small", effort: "medium" }, providerInstanceId: "engine-home" });
    expect(turnReceipt(moved, names)).toEqual({
      account: "Home account", instanceId: "engine-home", model: "small", effort: "medium",
      selected: { instanceId: "engine-work", model: "big", effort: "high" },
    });
  });

  it("adds the engine's own model name when it reports a different one", () => {
    expect(turnReceipt(evidence({ reportedModel: "big-2026", attribution: "provider" }), names)?.reportedModel).toBe("big-2026");
    expect(turnReceipt(evidence({ reportedModel: "big", attribution: "provider" }), names)?.reportedModel).toBeUndefined();
  });

  it("does not claim the dispatched model when another engine answered", () => {
    expect(turnReceipt(evidence({ attribution: "conflict", providerInstanceId: "engine-home" }), names)).toBeUndefined();
    expect(turnReceipt(evidence({ attribution: "conflict", providerInstanceId: "engine-home", reportedModel: "small" }), names))
      .toEqual({ account: "Home account", instanceId: "engine-home", model: "small" });
  });

  it("leaves the account out when the home does not know its name", () => {
    expect(turnReceipt(evidence(), () => undefined)).toEqual({ instanceId: "engine-work", model: "big", effort: "high" });
  });
});
