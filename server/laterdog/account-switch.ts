import { resetLabel, type BatteryAccount, type Rest } from "./account-battery.ts";

export const SWITCH_ACCOUNT_PATH = "/api/internal/switch-account";

export function accountLabel(account: BatteryAccount): string {
  const local = account.email?.split("@")[0]?.trim();
  return local || account.displayName || account.instanceId;
}

function words(text: string): string {
  return text.trim().toLowerCase().replace(/^(switch|move|continue|go|run)\s+(to|with|on|onto)\s+/, "").replace(/^(the\s+)?/, "").replace(/\s+account$/, "").trim();
}

export function matchAccount(asked: string, accounts: readonly BatteryAccount[]): BatteryAccount | BatteryAccount[] {
  const want = words(asked);
  if (!want) return [];
  const exact = accounts.filter((account) => [account.instanceId, account.email, accountLabel(account), account.displayName]
    .some((name) => name?.trim().toLowerCase() === want));
  if (exact.length === 1) return exact[0]!;
  const loose = accounts.filter((account) => [account.instanceId, account.email, accountLabel(account)]
    .some((name) => name?.toLowerCase().startsWith(want)));
  return loose.length === 1 ? loose[0]! : exact.length ? exact : loose;
}

export function accountNames(accounts: readonly BatteryAccount[]): string {
  return accounts.map(accountLabel).join(", ");
}

export function unusable(account: BatteryAccount): string | null {
  if (!account.enabled) return "switched off";
  if (account.signedIn === false) return "not signed in";
  if (!account.eligible) return "not a plan account later.dog can switch to";
  return null;
}

export function switchedWords(input: {
  picked: BatteryAccount;
  runsOn: BatteryAccount | undefined;
  rest: Rest | undefined;
  now: number;
  timeZone?: string;
}): string {
  const picked = accountLabel(input.picked);
  if (!input.runsOn || input.runsOn.instanceId === input.picked.instanceId) return `This chat is on ${picked} now.`;
  const why = input.rest && Date.parse(input.rest.until) > input.now
    ? `${picked} is used up until ${resetLabel(input.rest.until, input.now, input.timeZone)}`
    : unusable(input.picked) ? `${picked} is ${unusable(input.picked)}` : `${picked} is busy`;
  return `This chat is set to ${picked}, but ${why}, so it runs on ${accountLabel(input.runsOn)} until then.`;
}
