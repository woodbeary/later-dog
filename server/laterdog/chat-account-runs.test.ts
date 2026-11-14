import { describe, expect, it } from "vitest";
import type { ModelSelection } from "../contracts.ts";
import type { ThreadEngine } from "../thread-model.ts";
import type { BatteryAccount } from "./account-battery.ts";
import { accountRunsNow, teammateAccountRuns, type ChatAccountFacts } from "./chat-account-runs.ts";

type State = "on" | "off";
const DRIVERS: Record<string, string> = { spare: "claudeAgent", claude: "claudeAgent", codex: "codex" };
const MODELS: Record<string, string> = { claudeAgent: "claude-opus-5", codex: "gpt-6.1-sol" };

const engine = (instanceId: string, state: State): ThreadEngine => ({
  instanceId, driverKind: DRIVERS[instanceId]!, enabled: state === "on", snapshot: { state: "available", authenticated: true },
  models: { default: MODELS[DRIVERS[instanceId]!]!, options: [{ id: MODELS[DRIVERS[instanceId]!]!, label: "Model" }] },
});
const account = (instanceId: string, state: State): BatteryAccount => ({
  instanceId, driverKind: DRIVERS[instanceId]!, displayName: instanceId, enabled: state === "on", eligible: true,
  signedIn: true, models: [MODELS[DRIVERS[instanceId]!]!], defaultModel: MODELS[DRIVERS[instanceId]!]!,
});

const OWN: ModelSelection = { instanceId: "spare", model: "claude-opus-5" };
const CLAUDE_DOG: ModelSelection = { instanceId: "claude", model: "claude-opus-5" };
const CODEX_DOG: ModelSelection = { instanceId: "codex", model: "gpt-6.1-sol" };

function facts(on: Record<string, State>, dog: ModelSelection, pinned = false): ChatAccountFacts {
  return {
    turn: { own: OWN, dog, projected: OWN, context: { pinned }, engine: (instanceId) => instanceId in on ? engine(instanceId, on[instanceId]!) : undefined },
    dog, route: (selection) => selection, accounts: Object.entries(on).map(([instanceId, state]) => account(instanceId, state)),
  };
}

const verdicts = (chat: ChatAccountFacts, resting = false) => ({
  teammate: teammateAccountRuns(chat),
  revive: accountRunsNow({ ...chat, resting: () => resting }),
});

describe("whether a chat's account can run, seen by the stall watch and dog revival", () => {
  it("can run when the chat's own model is on an account that is off but the selection that runs is fine", () => {
    expect(verdicts(facts({ spare: "off", claude: "on" }, CLAUDE_DOG))).toEqual({ teammate: true, revive: true });
  });

  it("cannot run when the chat's own model is on an account that is on but the selection that runs is off", () => {
    expect(verdicts(facts({ spare: "on", codex: "off" }, CODEX_DOG, true))).toEqual({ teammate: false, revive: false });
  });

  it("cannot run when the person's pick is kept on an account that is off", () => {
    expect(verdicts(facts({ spare: "off", codex: "on" }, CODEX_DOG))).toEqual({ teammate: false, revive: false });
  });

  it("decides on the account the battery routes to", () => {
    const chat = { ...facts({ spare: "off", claude: "on" }, OWN), turn: undefined };
    expect(verdicts({ ...chat, route: () => CLAUDE_DOG })).toEqual({ teammate: true, revive: true });
    expect(verdicts(chat)).toEqual({ teammate: false, revive: false });
  });

  it("revives only a dog whose account is not resting, while a teammate on a resting account still counts as able to run", () => {
    expect(verdicts(facts({ spare: "on", claude: "on" }, CLAUDE_DOG), true)).toEqual({ teammate: true, revive: false });
  });

  it("revives a dog whose account is on with no reading yet, as the selection would run it", () => {
    const chat = facts({ spare: "on", claude: "on" }, CLAUDE_DOG);
    const unread = chat.accounts.map((account) => ({ ...account, signedIn: undefined }));
    expect(verdicts({ ...chat, accounts: unread })).toEqual({ teammate: true, revive: true });
    expect(verdicts({ ...chat, accounts: chat.accounts.map((account) => ({ ...account, signedIn: false })) })).toEqual({ teammate: false, revive: false });
  });
});
