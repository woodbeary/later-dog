import { ACCOUNT_USAGE_PATH, accountUsage, accountUsageText, type AccountUsageInput } from "../laterdog/account-usage.ts";
import type { BotRecord } from "../store.ts";
import type { InternalRouteHandler } from "./internal.ts";
import { PASS } from "./table.ts";

export interface AccountUsageRouteDeps {
  active(capability: unknown): boolean;
  refresh(fresh: boolean): Promise<void>;
  accounts(): AccountUsageInput[];
  current(sender: BotRecord, threadId: string): string | undefined;
  timeZone(): string | undefined;
  now?: () => number;
}

export function createAccountUsageRoute(deps: AccountUsageRouteDeps): InternalRouteHandler {
  return async ({ res, url, path, method, json, capability, sender, threadId }) => {
    if (method !== "GET" || path !== ACCOUNT_USAGE_PATH) return PASS;
    if (!deps.active(capability)) return json(res, 401, { error: "the internal turn capability has expired" });
    try {
      await deps.refresh(url.searchParams.get("refresh") === "1");
    } catch {}
    const now = deps.now?.() ?? Date.now();
    const report = accountUsage(deps.accounts(), deps.current(sender, threadId), now);
    return json(res, 200, { ...report, text: accountUsageText(report, now, deps.timeZone()) });
  };
}
