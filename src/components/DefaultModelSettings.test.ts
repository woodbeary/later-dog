import { describe, expect, it } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { pickKey, readyAccounts, selectionForPick } from "./DefaultModelSettings";

const claude = {
  instanceId: "claude",
  driverKind: "claudeAgent",
  displayName: "Claude",
  snapshot: { state: "available", authenticated: true },
  capabilities: { effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  models: {
    default: "claude-opus-5-5",
    options: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", effortLevels: [] },
    ],
  },
} as unknown as InstanceInfo;

const signedOut = { ...claude, instanceId: "work", snapshot: { state: "available", authenticated: false } } as InstanceInfo;

describe("default model for new dogs", () => {
  it("offers only accounts that can run a dog", () => {
    expect(readyAccounts([claude, signedOut]).map((instance) => instance.instanceId)).toEqual(["claude"]);
  });

  it("picks the model with its own default effort", () => {
    expect(selectionForPick([claude], pickKey({ instanceId: "claude", model: "claude-opus-5-5" })))
      .toEqual({ instanceId: "claude", model: "claude-opus-5-5", effort: "medium" });
    expect(selectionForPick([claude], pickKey({ instanceId: "claude", model: "claude-haiku-4-5" })))
      .toEqual({ instanceId: "claude", model: "claude-haiku-4-5" });
    expect(selectionForPick([claude], pickKey({ instanceId: "claude", model: "gone" }))).toBeUndefined();
  });
});
