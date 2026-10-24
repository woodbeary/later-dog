import { largeHomeAccounts } from "./size.ts";

export const KEEP_UP_EVERY_S = 10 * 60;

export function alwaysOn(list: string | undefined, accountId: string): boolean {
  return largeHomeAccounts(list).includes(accountId);
}

export const IDLE_SLEEP_AFTER = "30m";
const SLEEP_AFTER = /^\d{1,4}[smh]$/;

export function personSleepAfter(configured: string | undefined): string {
  const value = configured?.trim() ?? "";
  return SLEEP_AFTER.test(value) ? value : IDLE_SLEEP_AFTER;
}
