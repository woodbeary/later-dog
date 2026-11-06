import type { ModelSelection } from "../../shared/wire.ts";
import { selectionOnAccount, type BatteryAccount, type Rest } from "../laterdog/account-battery.ts";
import { accountLabel, accountNames, matchAccount, SWITCH_ACCOUNT_PATH, switchedWords, unusable } from "../laterdog/account-switch.ts";
import type { BotRecord } from "../store.ts";
import type { InternalRouteHandler } from "./internal.ts";
import { PASS } from "./table.ts";

export interface SwitchAccountRouteDeps {
  active(capability: unknown): boolean;
  accounts(): BatteryAccount[];
  chat(sender: BotRecord, threadId: string): BotRecord | null;
  check(chat: BotRecord, selection: ModelSelection): { ok: true; selection: ModelSelection } | { ok: false; status: number; error: string };
  save(sender: BotRecord, threadId: string, selection: ModelSelection): void;
  release(threadId: string): void;
  route(selection: ModelSelection, accounts: readonly BatteryAccount[], threadId: string): ModelSelection;
  rest(account: BatteryAccount, accounts: readonly BatteryAccount[], model: string): Rest | undefined;
  preferred(threadId: string): readonly ModelSelection[] | undefined;
  timeZone(): string | undefined;
  now?: () => number;
}

export function createSwitchAccountRoute(deps: SwitchAccountRouteDeps): InternalRouteHandler {
  return async ({ res, path, method, json, readBody, capability, sender, threadId }) => {
    if (method !== "POST" || path !== SWITCH_ACCOUNT_PATH) return PASS;
    if (!deps.active(capability)) return json(res, 401, { error: "the internal turn capability has expired" });
    const body = await readBody();
    const asked = typeof body?.account === "string" ? body.account.slice(0, 200) : "";
    const accounts = deps.accounts();
    const listed = accounts.filter((account) => account.eligible);
    const found = matchAccount(asked, listed);
    if (Array.isArray(found)) {
      return json(res, 404, {
        error: found.length
          ? `"${asked}" fits more than one account: ${accountNames(found)}. Ask which one.`
          : `No account called "${asked}". The accounts here are ${accountNames(listed)}.`,
      });
    }
    const chat = deps.chat(sender, threadId);
    if (!chat) return json(res, 409, { error: "Only your own chats can switch accounts this way. In a group chat, Jacob picks the account from the chat header." });
    const why = unusable(found);
    if (why) return json(res, 409, { error: `${accountLabel(found)} is ${why}, so this chat stays where it is. The accounts here are ${accountNames(listed)}.` });
    const next = selectionOnAccount(chat.modelSelection, found, accounts, deps.preferred(threadId));
    const checked = deps.check(chat, next);
    if (!checked.ok) return json(res, checked.status, { error: checked.error });
    if (checked.selection.instanceId !== chat.modelSelection.instanceId || checked.selection.model !== chat.modelSelection.model) {
      deps.save(sender, threadId, checked.selection);
    }
    deps.release(threadId);
    const now = deps.now?.() ?? Date.now();
    const runs = deps.route(checked.selection, accounts, threadId);
    const runsOn = accounts.find((account) => account.instanceId === runs.instanceId);
    const text = switchedWords({ picked: found, runsOn, rest: deps.rest(found, accounts, checked.selection.model), now, timeZone: deps.timeZone() });
    return json(res, 200, { account: found.instanceId, runsOn: runs.instanceId, text });
  };
}
