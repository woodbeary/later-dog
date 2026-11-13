import type { AccountChoice } from "./account-choice.ts";

export function waitsOnPerson(choice: AccountChoice): boolean {
  return choice.kind === "waiting" && choice.blocked !== "limit";
}

export function switchedOff(choice: AccountChoice): boolean {
  return choice.kind === "waiting" && choice.blocked === "off";
}

export function accountNeedsYou(input: { carriesOn: boolean; choice: AccountChoice; name: (instanceId: string) => string | undefined }): string | undefined {
  const { choice } = input;
  if (!input.carriesOn || choice.kind !== "waiting" || !waitsOnPerson(choice)) return undefined;
  const name = input.name(choice.chosen)?.trim() || choice.chosen;
  return choice.blocked === "off" ? `Turn ${name} back on` : `Sign in to ${name} again`;
}
