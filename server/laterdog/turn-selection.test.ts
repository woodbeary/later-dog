import { describe, expect, it } from "vitest";
import type { ModelSelection } from "../contracts.ts";
import type { ThreadEngine } from "../thread-model.ts";
import type { BatteryAccount } from "./account-battery.ts";
import { decideAccount } from "./account-choice.ts";
import { switchedOff } from "./account-needs-you.ts";
import { turnSelectionFor } from "./turn-selection.ts";

const engine = (instanceId: string, enabled: boolean): ThreadEngine => ({
  instanceId, driverKind: "claudeAgent", enabled, snapshot: { state: "available" },
  models: { options: [{ id: "claude-opus-5", label: "Claude Opus 5" }, { id: "claude-opus-5-5", label: "Claude Opus 5.5" }] },
} as ThreadEngine);
const account = (instanceId: string, enabled: boolean): BatteryAccount => ({
  instanceId, driverKind: "claudeAgent", displayName: instanceId, enabled, eligible: true, signedIn: true,
  models: ["claude-opus-5", "claude-opus-5-5"], defaultModel: "claude-opus-5-5",
});

const OWN: ModelSelection = { instanceId: "spare", model: "claude-opus-5" };
const DOG: ModelSelection = { instanceId: "claude", model: "claude-opus-5-5" };

function heldWhileOff(on: Record<string, boolean>, own: ModelSelection | undefined = OWN) {
  const run = turnSelectionFor({
    own, dog: DOG, projected: own ?? DOG,
    engine: (instanceId) => instanceId in on ? engine(instanceId, on[instanceId]!) : undefined,
  });
  const accounts = Object.entries(on).map(([instanceId, enabled]) => account(instanceId, enabled));
  return { run, held: switchedOff(decideAccount({ chosen: run, accounts, keepGoing: false, resting: {}, now: 0 })) };
}

describe("a chat's own model on a switched-off account", () => {
  it("gives way to the dog's model before the hold is considered, so the turn runs on the dog's account", () => {
    expect(heldWhileOff({ spare: false, claude: true })).toEqual({ run: DOG, held: false });
  });

  it("gives way when its account is gone altogether", () => {
    expect(heldWhileOff({ claude: true })).toEqual({ run: DOG, held: false });
  });

  it("is held when the dog's own account is switched off as well", () => {
    expect(heldWhileOff({ spare: false, claude: false })).toEqual({ run: DOG, held: true });
  });

  it("keeps its own model and runs when its account is on", () => {
    expect(heldWhileOff({ spare: true, claude: true })).toEqual({ run: OWN, held: false });
  });

  it("is held when the dog's account is switched off and the chat has no model of its own", () => {
    expect(heldWhileOff({ claude: false }, undefined)).toEqual({ run: DOG, held: true });
  });
});
