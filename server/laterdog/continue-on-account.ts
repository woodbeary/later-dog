import type { ModelSelection } from "../../shared/wire.ts";
import { failedTurnTool, type FailedTurnTool } from "../../shared/failed-turn.ts";
import { CONTINUE_AFTER_SWITCH, switchNotice, type AccountBattery, type BatteryAccount } from "./account-battery.ts";

export interface PathMessage {
  id: string;
  role: string;
  kind: string;
  tool?: { name?: string; ok?: boolean; itemId?: string; quota?: { instanceId?: string } };
}

export interface Notice {
  name: string;
  ok: true;
}

export type ContinueOnCheck =
  | { ok: true; from: BatteryAccount; to: BatteryAccount }
  | { ok: false; status: 400 | 404 | 409; error: string };

export type ContinueOnResult =
  | { status: 200; body: { continued: boolean } }
  | { status: 400 | 404 | 409; body: { error: string } };

const accountName = (account: BatteryAccount) => account.displayName || account.instanceId;

const requestIndex = (path: readonly PathMessage[]) =>
  path.findLastIndex((message) => message.role === "user" && message.kind === "text");

export function latestLimit<M extends PathMessage>(path: readonly M[]): M | undefined {
  return path.slice(requestIndex(path) + 1).findLast((message) =>
    message.role === "bot" && message.kind === "activity" && message.tool?.ok === false && Boolean(message.tool.quota));
}

export function checkContinueOn(input: {
  accounts: readonly BatteryAccount[];
  selection: ModelSelection;
  from: string;
  to: unknown;
  resting: (account: BatteryAccount) => boolean;
}): ContinueOnCheck {
  const { accounts, selection } = input;
  if (typeof input.to !== "string" || !input.to) return { ok: false, status: 400, error: "Pick an account to continue on." };
  const from = accounts.find((account) => account.instanceId === input.from);
  const to = accounts.find((account) => account.instanceId === input.to);
  if (!from?.eligible) return { ok: false, status: 409, error: "This dog's account can't switch." };
  if (!to?.eligible) return { ok: false, status: 404, error: "That account isn't available any more." };
  if (to.instanceId === from.instanceId) return { ok: false, status: 409, error: "That's the account that ran out." };
  if (to.driverKind !== from.driverKind) return { ok: false, status: 409, error: `${accountName(to)} can't run this dog.` };
  if (!to.enabled || to.signedIn === false) return { ok: false, status: 409, error: `${accountName(to)} isn't signed in.` };
  if (from.models.includes(selection.model) && !to.models.includes(selection.model)) {
    return { ok: false, status: 409, error: `${accountName(to)} doesn't offer this dog's model.` };
  }
  if (input.resting(to)) return { ok: false, status: 409, error: `${accountName(to)} is out of usage too.` };
  return { ok: true, from, to };
}

export function continueOnAccount(input: {
  battery: AccountBattery;
  accounts: readonly BatteryAccount[];
  threadId: string;
  selection: ModelSelection;
  busy: boolean;
  generation: string | undefined;
  path: readonly PathMessage[];
  instanceId: unknown;
  write: (tool: Notice | FailedTurnTool, replaceId?: string) => void;
  now?: number;
}): ContinueOnResult {
  const { battery, accounts, selection, path } = input;
  if (input.busy) return { status: 409, body: { error: "This dog is still working." } };
  const limit = latestLimit(path);
  const check = checkContinueOn({
    accounts, selection, from: limit?.tool?.quota?.instanceId ?? selection.instanceId, to: input.instanceId,
    resting: (account) => Boolean(battery.restOf(account, accounts, selection.model)),
  });
  if (!check.ok) return { status: check.status, body: { error: check.error } };
  const { from, to } = check;
  battery.choose(input.threadId, from.instanceId, to.instanceId);
  const turn = battery.takeTurn(input.threadId, input.generation);
  const at = requestIndex(path);
  if (!turn?.rerun || at === -1 || path[at]!.id !== turn.requestMessageId) return { status: 200, body: { continued: false } };
  const rest = battery.restOf(from, accounts, selection.model);
  input.write({ name: `recovery: ${switchNotice({ to: accountName(to), from: accountName(from), rest, now: input.now ?? Date.now() })}`, ok: true }, limit?.id);
  const toolRan = path.slice(at + 1).some((message) => message.kind === "activity" && Boolean(message.tool?.itemId));
  void turn.rerun(toolRan ? CONTINUE_AFTER_SWITCH : null).catch((error: unknown) => {
    input.write(failedTurnTool(`Could not continue on ${accountName(to)}: ${error instanceof Error ? error.message : String(error)}`));
  });
  return { status: 200, body: { continued: true } };
}
