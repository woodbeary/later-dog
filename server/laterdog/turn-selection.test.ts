import { describe, expect, it } from "vitest";
import type { ModelSelection } from "../contracts.ts";
import type { ThreadEngine } from "../thread-model.ts";
import { signedInReading, type BatteryAccount } from "./account-battery.ts";
import { decideAccount } from "./account-choice.ts";
import { switchedOff, waitsOnPerson } from "./account-needs-you.ts";
import { turnSelectionFor } from "./turn-selection.ts";

type State = "on" | "off" | "signed-out" | "not-installed" | "off-check-failed" | "off-program-missing" | "check-failed" | "check-timed-out" | "program-missing";
const SNAPSHOTS: Partial<Record<State, ThreadEngine["snapshot"]>> = {
  "not-installed": { state: "unavailable", reason: "missing" },
  "off-check-failed": { state: "unavailable", reason: "`claude` did not answer" },
  "off-program-missing": { state: "unavailable", reason: "`claude` CLI not found", missing: true },
  "check-failed": { state: "unavailable", reason: "probe exploded", checkFailed: true },
  "check-timed-out": { state: "unavailable", reason: "`claude` is still starting", starting: true },
  "program-missing": { state: "unavailable", reason: "`claude` CLI not found", missing: true },
};
const snapshotOf = (state: State): ThreadEngine["snapshot"] => SNAPSHOTS[state] ?? { state: "available", authenticated: state !== "signed-out" };
const DRIVERS: Record<string, string> = { spare: "claudeAgent", claude: "claudeAgent", codex: "codex" };
const MODELS: Record<string, string> = { claudeAgent: "claude-opus-5", codex: "gpt-6.1-sol" };

const engine = (instanceId: string, state: State): ThreadEngine => ({
  instanceId, driverKind: DRIVERS[instanceId]!, enabled: !state.startsWith("off"),
  snapshot: snapshotOf(state),
  models: { options: [{ id: MODELS[DRIVERS[instanceId]!]!, label: "Model" }, { id: "claude-opus-5-5", label: "Claude Opus 5.5" }] },
} as ThreadEngine);
const account = (instanceId: string, state: State): BatteryAccount => ({
  instanceId, driverKind: DRIVERS[instanceId]!, displayName: instanceId, enabled: !state.startsWith("off"), eligible: true,
  ...signedInReading(snapshotOf(state)), models: [MODELS[DRIVERS[instanceId]!]!, "claude-opus-5-5"], defaultModel: MODELS[DRIVERS[instanceId]!]!,
});

const OWN: ModelSelection = { instanceId: "spare", model: "claude-opus-5" };
const CLAUDE_DOG: ModelSelection = { instanceId: "claude", model: "claude-opus-5-5" };
const CODEX_DOG: ModelSelection = { instanceId: "codex", model: "gpt-6.1-sol" };

function turn(on: Record<string, State>, dog: ModelSelection, own: ModelSelection | undefined = OWN, resting: Record<string, { until: string; since: string }> = {}) {
  const run = turnSelectionFor({
    own, dog, projected: own ?? dog, context: { ownerSelection: own, pinned: true },
    engine: (instanceId) => instanceId in on ? engine(instanceId, on[instanceId]!) : undefined,
  });
  const accounts = Object.entries(on).map(([instanceId, state]) => account(instanceId, state));
  const choice = decideAccount({ chosen: run, accounts, keepGoing: false, resting, now: 0 });
  return { run, held: switchedOff(choice), person: waitsOnPerson(choice) };
}

describe("a chat's own model on an account that cannot run", () => {
  it("gives way to the dog's model on the same engine when its account is switched off", () => {
    expect(turn({ spare: "off", claude: "on" }, CLAUDE_DOG)).toEqual({ run: CLAUDE_DOG, held: false, person: false });
  });

  it("gives way to the dog's model on the same engine when its account is signed out", () => {
    expect(turn({ spare: "signed-out", claude: "on" }, CLAUDE_DOG)).toEqual({ run: CLAUDE_DOG, held: false, person: false });
  });

  it("gives way whatever the engine when its account is gone or its engine is not installed", () => {
    expect(turn({ claude: "on" }, CLAUDE_DOG)).toEqual({ run: CLAUDE_DOG, held: false, person: false });
    expect(turn({ codex: "on" }, CODEX_DOG)).toEqual({ run: CODEX_DOG, held: false, person: false });
    expect(turn({ spare: "not-installed", codex: "on" }, CODEX_DOG).run).toEqual(CODEX_DOG);
  });

  it("keeps the person's pick and is held when its account is switched off and the dog runs on another engine", () => {
    expect(turn({ spare: "off", codex: "on" }, CODEX_DOG)).toEqual({ run: OWN, held: true, person: true });
  });

  it("keeps the person's pick and is held when its account is switched off and its last check failed", () => {
    expect(turn({ spare: "off-check-failed", codex: "on" }, CODEX_DOG)).toEqual({ run: OWN, held: true, person: true });
  });

  it("gives way across engines when its account is switched off and its program is missing", () => {
    expect(turn({ spare: "off-program-missing", codex: "on" }, CODEX_DOG).run).toEqual(CODEX_DOG);
  });

  it("gives way across engines when its account is removed or refused by policy", () => {
    expect(turn({ codex: "on" }, CODEX_DOG).run).toEqual(CODEX_DOG);
    const refused = turnSelectionFor({
      own: OWN, dog: CODEX_DOG, projected: OWN, context: { ownerSelection: OWN, pinned: true, refusal: (instance) => instance.instanceId === "spare" ? "not allowed" : undefined },
      engine: (instanceId) => engine(instanceId, instanceId === "spare" ? "off-check-failed" : "on"),
    });
    expect(refused).toEqual(CODEX_DOG);
  });

  it("keeps the person's pick and waits for a sign-in when its account is signed out and the dog runs on another engine", () => {
    expect(turn({ spare: "signed-out", codex: "on" }, CODEX_DOG)).toEqual({ run: OWN, held: false, person: true });
  });

  it("is held when the dog's own account is switched off as well", () => {
    expect(turn({ spare: "off", claude: "off" }, CLAUDE_DOG)).toEqual({ run: CLAUDE_DOG, held: true, person: true });
  });

  it("keeps its own model and runs when its account is on", () => {
    expect(turn({ spare: "on", claude: "on" }, CLAUDE_DOG)).toEqual({ run: OWN, held: false, person: false });
  });

  it("waits for usage, not for the person, when a kept turn's own account is switched off and the dog's account is resting", () => {
    const resting = { claude: { until: new Date(3_600_000).toISOString(), since: new Date(0).toISOString() } };
    expect(turn({ spare: "off", claude: "on" }, CLAUDE_DOG, OWN, resting)).toEqual({ run: CLAUDE_DOG, held: false, person: false });
  });
});

describe("a chat whose account's check failed without an answer", () => {
  it("keeps the pick on its own engine and asks nobody to sign in when the check failed or timed out", () => {
    for (const state of ["check-failed", "check-timed-out"] as const) {
      expect(turn({ spare: state, codex: "on" }, CODEX_DOG)).toEqual({ run: OWN, held: false, person: false });
      expect(turn({ spare: state, claude: "on" }, CLAUDE_DOG)).toEqual({ run: OWN, held: false, person: false });
    }
  });

  it("still asks to sign in after a definite signed-out answer", () => {
    expect(turn({ spare: "signed-out", codex: "on" }, CODEX_DOG)).toEqual({ run: OWN, held: false, person: true });
  });

  it("still gives way when its program is missing", () => {
    expect(turn({ spare: "program-missing", codex: "on" }, CODEX_DOG).run).toEqual(CODEX_DOG);
  });

  it("leaves the battery's signed-in reading unset rather than signed out", () => {
    expect(signedInReading({ state: "unavailable", checkFailed: true })).toEqual({});
    expect(signedInReading({ state: "unavailable", starting: true })).toEqual({});
    expect(signedInReading({ state: "available", authenticated: false })).toEqual({ signedIn: false });
    expect(signedInReading({ state: "unavailable", missing: true })).toEqual({ signedIn: false });
  });
});
