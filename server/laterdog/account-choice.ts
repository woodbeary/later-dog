import type { ModelSelection, WireAccountRoute } from "../../shared/wire.ts";
import type { PlanProviderRow } from "../plan-usage.ts";
import { activeRest, percentLeft, selectionOnAccount, type BatteryAccount, type Rest } from "./account-battery.ts";
import { NEARLY_EMPTY_PERCENT } from "./account-spread.ts";

export type Blocked = "limit" | "signIn" | "signedOut" | "off";

export interface AccountChoiceInput {
  chosen: ModelSelection;
  accounts: readonly BatteryAccount[];
  keepGoing: boolean;
  resting: Readonly<Record<string, Rest>>;
  usage?: (instanceId: string) => PlanProviderRow | undefined;
  now: number;
  order?: readonly string[];
  current?: string;
  handPicked?: string;
  preferred?: readonly ModelSelection[];
}

export type AccountChoice =
  | { kind: "chosen"; run: ModelSelection }
  | { kind: "covering"; run: ModelSelection; chosen: string; blocked: Blocked; until?: string; byHand?: true }
  | { kind: "waiting"; run: ModelSelection; chosen: string; blocked: Blocked; until?: string };

export interface Room {
  left?: number;
  credits: boolean;
}

export function roomOf(row: PlanProviderRow | undefined, now: number): Room {
  const credits = Boolean(row?.ok && row.credits && (row.credits.unlimited || row.credits.balance === null || Number(row.credits.balance) > 0));
  const left = percentLeft(row, now);
  return left === undefined ? { credits } : { left, credits };
}

export type RoomRank = 0 | 1 | 2 | 3;

const NEARLY_EMPTY_RANK: RoomRank = 3;

export function roomRank(room: Room): RoomRank {
  if (room.left !== undefined && room.left > NEARLY_EMPTY_PERCENT) return 0;
  if (room.credits) return 1;
  return room.left === undefined ? 2 : NEARLY_EMPTY_RANK;
}

function blockedBy(account: BatteryAccount, rest: Rest | undefined): Blocked | undefined {
  if (!account.enabled) return "off";
  if (account.signedIn === false) return "signedOut";
  if (rest) return rest.kind === "setup" ? "signIn" : "limit";
  return undefined;
}

function offers(account: BatteryAccount, own: BatteryAccount, model: string): boolean {
  return !own.models.includes(model) || account.models.includes(model);
}

function canCover(account: BatteryAccount, own: BatteryAccount, model: string): boolean {
  return account !== own && account.eligible && account.enabled && account.signedIn === true &&
    (account.driverKind !== own.driverKind ? Boolean(account.defaultModel || account.models.length) : offers(account, own, model));
}

function handAccount(input: AccountChoiceInput, own: BatteryAccount): BatteryAccount | undefined {
  const hand = input.handPicked ? input.accounts.find((account) => account.instanceId === input.handPicked) : undefined;
  return hand && canCover(hand, own, input.chosen.model) ? hand : undefined;
}

export function sameEngineCovers(input: AccountChoiceInput): BatteryAccount[] {
  const { chosen, accounts, now } = input;
  const own = accounts.find((account) => account.instanceId === chosen.instanceId);
  if (!own) return [];
  return accounts.filter((account) => account.driverKind === own.driverKind && canCover(account, own, chosen.model) &&
    !activeRest(account, chosen.model, accounts, input.resting, now));
}

export function rankByRoom(candidates: readonly BatteryAccount[], input: Pick<AccountChoiceInput, "usage" | "now" | "order">): BatteryAccount[] {
  const order = input.order ?? [];
  const position = (id: string) => { const at = order.indexOf(id); return at === -1 ? order.length : at; };
  const scored = candidates.map((account, index) => {
    const room = roomOf(input.usage?.(account.instanceId), input.now);
    return { account, rank: roomRank(room), left: room.left ?? 0, position: position(account.instanceId), index };
  });
  return scored.sort((a, b) => a.rank - b.rank || b.left - a.left || a.position - b.position || a.index - b.index)
    .map(({ account }) => account);
}

export function decideAccount(input: AccountChoiceInput): AccountChoice {
  const { chosen, accounts, now } = input;
  const own = accounts.find((account) => account.instanceId === chosen.instanceId);
  if (!own?.eligible) return { kind: "chosen", run: chosen };
  const rest = activeRest(own, chosen.model, accounts, input.resting, now);
  const blocked = blockedBy(own, rest);
  if (!blocked) return { kind: "chosen", run: chosen };
  const until = rest && Date.parse(rest.until) > now ? { until: rest.until } : {};
  const hand = handAccount(input, own);
  const handRun = hand ? selectionOnAccount(chosen, hand, accounts, input.preferred) : undefined;
  if (hand && handRun && !activeRest(hand, handRun.model, accounts, input.resting, now)) {
    return { kind: "covering", run: handRun, chosen: own.instanceId, blocked, ...until, byHand: true };
  }
  const waiting: AccountChoice = { kind: "waiting", run: chosen, chosen: own.instanceId, blocked, ...until };
  if (!input.keepGoing) return waiting;
  const ranked = rankByRoom(sameEngineCovers(input), input);
  const best = ranked[0];
  if (!best) return waiting;
  const current = ranked.find((account) => account.instanceId === input.current);
  const usage = (account: BatteryAccount) => roomRank(roomOf(input.usage?.(account.instanceId), now));
  const on = current && usage(current) === usage(best) && usage(current) !== NEARLY_EMPTY_RANK ? current : best;
  return { kind: "covering", run: { ...chosen, instanceId: on.instanceId }, chosen: own.instanceId, blocked, ...until };
}

export function choiceReadyAt(input: AccountChoiceInput): string | undefined {
  const { chosen, accounts, now } = input;
  const own = accounts.find((account) => account.instanceId === chosen.instanceId);
  if (!own || (own.eligible && decideAccount(input).kind !== "waiting")) return undefined;
  const hand = own.eligible ? handAccount(input, own) : undefined;
  const others = own.eligible && input.keepGoing ? accounts.filter((account) => account.driverKind === own.driverKind && canCover(account, own, chosen.model)) : [];
  let soonest = Infinity;
  for (const account of new Set([own, ...(hand ? [hand] : []), ...others])) {
    const model = account === hand ? selectionOnAccount(chosen, hand, accounts, input.preferred).model : chosen.model;
    const rest = activeRest(account, model, accounts, input.resting, now);
    if (!rest) return undefined;
    soonest = Math.min(soonest, Date.parse(rest.until));
  }
  return new Date(soonest).toISOString();
}

export interface Ran {
  on: string;
  model: string;
}

export type ShownRoute = WireAccountRoute & { next?: true };

export function shownRoute(choice: AccountChoice, chosen: ModelSelection, ran: Ran | undefined): ShownRoute | undefined {
  if (!ran || ran.on === chosen.instanceId) return undefined;
  const next = choice.run.instanceId !== ran.on;
  return { from: chosen.instanceId, on: ran.on, model: ran.model, ...(next ? { next: true as const } : {}) };
}
