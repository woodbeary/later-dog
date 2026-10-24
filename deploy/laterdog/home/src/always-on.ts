import { largeHomeAccounts } from "./size.ts";

export const KEEP_UP_EVERY_S = 10 * 60;

export function alwaysOn(list: string | undefined, accountId: string): boolean {
  return largeHomeAccounts(list).includes(accountId);
}
