import type { ModelSelection } from "../contracts.ts";
import type { BatteryAccount } from "./account-battery.ts";
import { turnSelectionFor, type TurnSelectionInput } from "./turn-selection.ts";

export interface ChatAccountFacts {
  turn: TurnSelectionInput | undefined;
  dog: ModelSelection;
  route: (selection: ModelSelection) => ModelSelection;
  accounts: readonly BatteryAccount[];
}

function accountThatRuns(facts: ChatAccountFacts): BatteryAccount | undefined {
  const on = facts.route(facts.turn ? turnSelectionFor(facts.turn) : facts.dog).instanceId;
  return facts.accounts.find((account) => account.instanceId === on);
}

export function teammateAccountRuns(facts: ChatAccountFacts): boolean {
  const account = accountThatRuns(facts);
  return !account || (account.enabled && account.signedIn !== false);
}

export function accountRunsNow(facts: ChatAccountFacts & { resting: (account: BatteryAccount) => boolean }): boolean {
  const account = accountThatRuns(facts);
  return Boolean(account?.eligible && account.enabled && account.signedIn !== false && !facts.resting(account));
}
