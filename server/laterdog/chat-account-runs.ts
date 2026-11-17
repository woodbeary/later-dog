import type { ModelSelection } from "../contracts.ts";
import type { BatteryAccount } from "./account-battery.ts";
import { turnSelectionFor, type TurnSelectionInput } from "./turn-selection.ts";

export interface ChatAccountFacts {
  turn: TurnSelectionInput | undefined;
  dog: ModelSelection;
  route: (selection: ModelSelection) => ModelSelection;
  accounts: readonly BatteryAccount[];
}

function selectionThatRuns(facts: ChatAccountFacts): { account: BatteryAccount | undefined; model: string } {
  const run = facts.route(facts.turn ? turnSelectionFor(facts.turn) : facts.dog);
  return { account: facts.accounts.find((account) => account.instanceId === run.instanceId), model: run.model };
}

export function teammateAccountRuns(facts: ChatAccountFacts): boolean {
  const { account } = selectionThatRuns(facts);
  return !account || (account.enabled && account.signedIn !== false);
}

export function accountRunsNow(facts: ChatAccountFacts & { resting: (account: BatteryAccount, model: string) => boolean }): boolean {
  const { account, model } = selectionThatRuns(facts);
  return Boolean(account?.eligible && account.enabled && account.signedIn !== false && !facts.resting(account, model));
}
