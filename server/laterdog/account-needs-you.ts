import type { AccountHold } from "../../shared/work-state.ts";
import type { AccountChoice } from "./account-choice.ts";

export function waitsOnPerson(choice: AccountChoice): boolean {
  return choice.kind === "waiting" && choice.blocked !== "limit";
}

export function switchedOff(choice: AccountChoice): boolean {
  return choice.kind === "waiting" && choice.blocked === "off";
}

export interface AccountNeedsYou {
  what: string;
  hold: AccountHold;
}

export function accountNeedsYou(input: { carriesOn: boolean; choice: AccountChoice; name: (instanceId: string) => string | undefined }): AccountNeedsYou | undefined {
  const { choice } = input;
  if (!input.carriesOn || choice.kind !== "waiting" || !waitsOnPerson(choice)) return undefined;
  const name = input.name(choice.chosen)?.trim() || choice.chosen;
  const why = choice.blocked === "off" ? "off" : "signed-out";
  return { what: why === "off" ? `Turn ${name} back on` : `Sign in to ${name} again`, hold: { account: name, accountId: choice.chosen, why } };
}
