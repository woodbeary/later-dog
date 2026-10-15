import { afterAll, describe, expect, it, vi } from "vitest";

import type { InstanceInfo } from "@/state/store";

vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});

const { railProviders } = await import("./ModelPicker");

afterAll(() => vi.unstubAllGlobals());

type Snapshot = InstanceInfo["snapshot"];
const engine = (instanceId: string, driverKind: string, displayName: string, snapshot: Snapshot): InstanceInfo => ({
  instanceId, driverKind, displayName, snapshot, models: { default: "m", options: [{ id: "m", label: "m" }] },
}) as InstanceInfo;
const live: Snapshot = { state: "available", authenticated: true };
const signedOut: Snapshot = { state: "available", authenticated: false };
const notInstalled: Snapshot = { state: "unavailable" } as Snapshot;
const trialOver: Snapshot = { state: "unavailable", reason: "Your free trial has ended." } as Snapshot;

const labels = (instances: InstanceInfo[]) => railProviders(instances, undefined, undefined, undefined).subscription.map((entry) => `${entry.label}:${entry.instance.instanceId}`);

describe("the free models beside the person's own accounts", () => {
  it("stand in for a Claude or Grok the person has not signed in to while the trial is on", () => {
    expect(labels([
      engine("claude", "claudeAgent", "Claude", signedOut),
      engine("grok", "grokAgent", "Grok", notInstalled),
      engine("laterdogAi", "laterdogAi", "Claude", live),
      engine("laterdogGrok", "laterdogGrok", "Grok", live),
    ])).toEqual(["Claude:laterdogAi", "Grok:laterdogGrok"]);
  });

  it("step aside once the person's own Claude or Grok is ready", () => {
    expect(labels([
      engine("claude", "claudeAgent", "Claude", live),
      engine("grok", "grokAgent", "Grok", live),
      engine("laterdogAi", "laterdogAi", "Claude", live),
      engine("laterdogGrok", "laterdogGrok", "Grok", live),
    ])).toEqual(["Claude:claude", "Grok:grok"]);
  });

  it("give the rail back to the person's Claude sign-in once the free Claude can't answer, with one Claude button", () => {
    expect(labels([
      engine("claude", "claudeAgent", "Claude", signedOut),
      engine("grok", "grokAgent", "Grok", notInstalled),
      engine("laterdogAi", "laterdogAi", "Claude", trialOver),
      engine("laterdogGrok", "laterdogGrok", "Grok", trialOver),
    ])).toEqual(["Claude:claude", "Grok:laterdogGrok"]);
  });
});
