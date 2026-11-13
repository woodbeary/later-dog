import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import type { PlanProviderRow } from "../plan-usage.ts";
import type { ModelSelection, WireAccountRoute } from "../../shared/wire.ts";
import { creditsSpendable } from "../../shared/spendable-credits.ts";
import { resetInstant } from "./usage-limit.ts";
import { NEARLY_EMPTY_PERCENT, roomTier } from "./account-spread.ts";
import { choiceReadyAt, decideAccount, shownRoute, type AccountChoice, type AccountChoiceInput, type Ran } from "./account-choice.ts";

export { NEARLY_EMPTY_PERCENT };

export const BATTERY_DRIVERS: readonly string[] = ["claudeAgent", "codex"];

export const DEFAULT_REST_MS = 5 * 60 * 60 * 1000;
export const SETUP_REST_MS = 30 * 60 * 1000;
export const SETUP_STOP = "setup";
export const USAGE_FRESH_MS = 2 * 60 * 1000;
export const USAGE_REFRESH_WAIT_MS = 10_000;
const MAX_AWAY = 500;
const MAX_TURNS = 2_000;
const MAX_PLACED = 2_000;
const MAX_RAN = 500;

export const CONTINUE_AFTER_SWITCH =
  "[later.dog: the account this conversation was running on reached its usage limit partway through your last turn, " +
  "so it continues on another account. Anything that turn already did (files written, commands run) is still in place, " +
  "but its tool results are not in this session. Check the current state, then continue the person's last request from " +
  "where it stopped. Do not redo what was already done.]";

export const CONTINUE_AFTER_RESET =
  "[later.dog: your last turn stopped partway because this conversation ran out of usage on every account it can use. " +
  "A limit has reset, so it carries on now. Anything that turn already did (files written, commands run) is still in place, " +
  "though its tool results may not be in this session. Check the current state, then continue the person's last request from " +
  "where it stopped. Do not redo what was already done.]";

export interface AccountBatteryConfig {
  enabled: boolean;
  order: Record<string, string[]>;
  auto?: boolean;
  sequence?: string[];
}

export type AccountBatteryPatch = Partial<AccountBatteryConfig>;

export type PlanReading = (instanceId: string) => PlanProviderRow | undefined;

export interface BatteryAccount {
  instanceId: string;
  driverKind: string;
  displayName?: string;
  enabled: boolean;
  eligible: boolean;
  signedIn?: boolean;
  email?: string;
  models: readonly string[];
  defaultModel?: string;
}

export interface Rest {
  until: string;
  kind?: string;
  estimated?: boolean;
  since: string;
  reading?: string;
}

export interface Quota {
  resetsAt?: string;
  kind?: string;
}

export interface BatteryTurn {
  generation: string;
  instanceId: string;
  requestMessageId?: string;
  rerun?: (continuation: string | null) => Promise<unknown>;
  pending?: boolean;
}

export interface BatteryRerun {
  turn: BatteryTurn;
  from: BatteryAccount;
  to: BatteryAccount;
  rest?: Rest;
  reason?: typeof SETUP_STOP | "usage_limit";
}

export interface BatteryStatus {
  enabled: boolean;
  auto: boolean;
  order: Record<string, string[]>;
  sequence: string[];
  resting: Record<string, Rest & { sharedWith?: string }>;
  routed: Record<string, WireAccountRoute>;
  fromNextMessage: Record<string, WireAccountRoute>;
}

const restSchema = z.object({
  until: z.string().max(64),
  kind: z.string().max(40).optional(),
  estimated: z.boolean().optional(),
  since: z.string().max(64),
  reading: z.string().max(512).optional(),
});
const stateSchema = z.object({
  version: z.literal(1),
  resting: z.record(z.string(), restSchema).default({}),
  away: z.record(z.string(), z.object({
    from: z.string(), at: z.string(), to: z.string().optional(), ranOut: z.string().optional(), pick: z.string().optional(), on: z.string().optional(),
  })).default({}),
  placed: z.record(z.string(), z.object({ on: z.string(), at: z.string(), from: z.string().optional() })).default({}),
  ran: z.record(z.string(), z.object({ on: z.string(), model: z.string(), at: z.string() })).default({}),
});
type BatteryState = z.output<typeof stateSchema>;

const emptyState = (): BatteryState => ({ version: 1, resting: {}, away: {}, placed: {}, ran: {} });

function readState(file: string | undefined): BatteryState {
  if (!file || !existsSync(file)) return emptyState();
  try {
    const parsed = stateSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : emptyState();
  } catch {
    return emptyState();
  }
}

export function batteryOrder(config: AccountBatteryConfig | undefined, accounts: readonly BatteryAccount[]): Record<string, string[]> {
  const order: Record<string, string[]> = {};
  for (const driver of BATTERY_DRIVERS) {
    const eligible = accounts.filter((account) => account.driverKind === driver && account.eligible).map((account) => account.instanceId);
    const saved = (config?.order?.[driver] ?? []).filter((id) => eligible.includes(id));
    order[driver] = [...new Set([...saved, ...eligible])];
  }
  return order;
}

export function restApplies(rest: Rest | undefined, model: string | undefined, now: number): boolean {
  if (!rest || !(Date.parse(rest.until) > now)) return false;
  if (model === undefined) return true;
  if (rest.kind === "opus") return /opus/i.test(model);
  if (rest.kind === "sonnet") return /sonnet/i.test(model);
  return true;
}

const sameLogin = (a: BatteryAccount, b: BatteryAccount) =>
  Boolean(a.driverKind === b.driverKind && a.email && b.email && a.email.trim().toLowerCase() === b.email.trim().toLowerCase());

export function activeRest(
  account: BatteryAccount,
  model: string | undefined,
  accounts: readonly BatteryAccount[],
  resting: Readonly<Record<string, Rest>>,
  now: number,
): (Rest & { sharedWith?: string }) | undefined {
  const own = resting[account.instanceId];
  if (restApplies(own, model, now)) return own;
  for (const other of accounts) {
    if (other.instanceId === account.instanceId || !sameLogin(account, other)) continue;
    const shared = resting[other.instanceId];
    if (restApplies(shared, model, now)) return { ...shared!, sharedWith: other.instanceId };
  }
  return undefined;
}

interface PickInput {
  config: AccountBatteryConfig | undefined;
  selection: ModelSelection;
  accounts: readonly BatteryAccount[];
  resting: Readonly<Record<string, Rest>>;
  now: number;
  usage?: PlanReading;
  preferred?: readonly ModelSelection[];
}

export function percentLeft(row: PlanProviderRow | undefined, now: number): number | undefined {
  if (!row?.ok) return undefined;
  const left = [row.fiveHour, row.weekly].filter((window) => window.available && window.usedPercent !== null).map((window) => {
    const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    return reset <= now ? 100 : Math.min(100, Math.max(0, 100 - window.usedPercent!));
  });
  return left.length ? Math.min(...left) : undefined;
}

export const USED_UP_PERCENT = 99.5;

export function usedUpRest(row: PlanProviderRow | undefined, now: number): Rest | undefined {
  if (!row?.ok || creditsSpendable(row.credits)) return undefined;
  const full = [{ kind: "session", window: row.fiveHour }, { kind: "weekly", window: row.weekly }]
    .map(({ kind, window }) => ({ kind, used: window.available ? window.usedPercent : null, reset: window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN }))
    .filter(({ used, reset }) => used !== null && used >= USED_UP_PERCENT && reset > now)
    .sort((a, b) => b.reset - a.reset)[0];
  return full ? { until: new Date(full.reset).toISOString(), kind: full.kind, since: new Date(now).toISOString() } : undefined;
}

export function withReadings(
  resting: Readonly<Record<string, Rest>>,
  accounts: readonly BatteryAccount[],
  usage: PlanReading | undefined,
  now: number,
): Record<string, Rest> {
  const merged: Record<string, Rest> = { ...resting };
  if (!usage) return merged;
  for (const account of accounts) {
    const reading = usedUpRest(usage(account.instanceId), now);
    if (!reading) continue;
    const own = resting[account.instanceId];
    const ownApplies = restApplies(own, undefined, now);
    if (ownApplies && own!.kind === SETUP_STOP) continue;
    if (!ownApplies || own!.kind === "opus" || own!.kind === "sonnet" || Date.parse(reading.until) > Date.parse(own!.until)) merged[account.instanceId] = reading;
  }
  return merged;
}

const KINDS_A_READING_SHOWS: ReadonlySet<string | undefined> = new Set([undefined, "session", "weekly"]);

function quotaReading(row: PlanProviderRow | undefined, kind: string | undefined) {
  if (!row?.ok) return undefined;
  const window = kind === "session" ? row.fiveHour : kind === "weekly" ? row.weekly : undefined;
  if (!window?.available || window.usedPercent === null) return undefined;
  const balance = row.credits?.balance == null ? NaN : Number(row.credits.balance);
  return {
    key: JSON.stringify([window.usedPercent, window.resetsAt, creditsSpendable(row.credits), row.credits?.unlimited, Number.isFinite(balance) ? balance : null]),
    hasRoom: creditsSpendable(row.credits) || window.usedPercent < USED_UP_PERCENT,
  };
}

export function readingsDisprove(
  resting: Readonly<Record<string, Rest>>,
  usage: PlanReading | undefined,
  usageAt: ((instanceId: string) => number | undefined) | undefined,
  now: number,
): string[] {
  return Object.entries(resting).filter(([instanceId, rest]) => {
    if (!KINDS_A_READING_SHOWS.has(rest.kind)) return false;
    const readAt = usageAt?.(instanceId);
    if (readAt === undefined || !(readAt > Date.parse(rest.since))) return false;
    const row = usage?.(instanceId);
    if (rest.estimated) {
      const left = percentLeft(row, now);
      return left !== undefined && left > NEARLY_EMPTY_PERCENT;
    }
    const reading = quotaReading(row, rest.kind);
    return reading?.hasRoom === true && reading.key !== rest.reading;
  }).map(([instanceId]) => instanceId);
}

export function rankOrder(order: Record<string, string[]>, input: Omit<PickInput, "config" | "selection">): Record<string, string[]> {
  const ranked: Record<string, string[]> = {};
  for (const [driver, ids] of Object.entries(order)) {
    const scores = new Map(ids.map((id, index) => {
      const account = input.accounts.find((candidate) => candidate.instanceId === id);
      const asleep = Boolean(account && activeRest(account, undefined, input.accounts, input.resting, input.now));
      return [id, { asleep, left: asleep ? undefined : percentLeft(input.usage?.(id), input.now), index }] as const;
    }));
    ranked[driver] = [...ids].sort((a, b) => {
      const x = scores.get(a)!;
      const y = scores.get(b)!;
      return Number(x.asleep) - Number(y.asleep) || roomTier(x.left) - roomTier(y.left) ||
        (y.left ?? 0) - (x.left ?? 0) || x.index - y.index;
    });
  }
  return ranked;
}

export function batteryEnabled(config: AccountBatteryConfig | undefined, accounts: readonly BatteryAccount[]): boolean {
  if (config?.enabled !== undefined) return config.enabled;
  return accounts.filter((account) => BATTERY_DRIVERS.includes(account.driverKind) && account.eligible &&
    account.enabled && account.signedIn !== false).length >= 2;
}

export function effectiveOrder(input: Omit<PickInput, "selection">): Record<string, string[]> {
  const order = batteryOrder(input.config, input.accounts);
  return batteryEnabled(input.config, input.accounts) && input.config?.auto ? rankOrder(order, input) : order;
}

export function batterySequence(input: Omit<PickInput, "selection">): string[] {
  const ids = Object.values(batteryOrder(input.config, input.accounts)).flat();
  const saved = (input.config?.sequence ?? []).filter((id) => ids.includes(id));
  const sequence = [...new Set([...saved, ...ids])];
  return batteryEnabled(input.config, input.accounts) && input.config?.auto
    ? rankOrder({ all: sequence }, input).all! : sequence;
}

export function chosenModelOn(account: BatteryAccount, accounts: readonly BatteryAccount[], preferred: readonly ModelSelection[] | undefined): string | undefined {
  const offers = (model: string) => account.models.length === 0 || account.models.includes(model);
  const exact = preferred?.find((entry) => entry.instanceId === account.instanceId && offers(entry.model));
  if (exact) return exact.model;
  return preferred?.find((entry) => accounts.find((candidate) => candidate.instanceId === entry.instanceId)?.driverKind === account.driverKind &&
    account.models.includes(entry.model))?.model;
}

export function selectionOnAccount(
  selection: ModelSelection,
  account: BatteryAccount,
  accounts: readonly BatteryAccount[],
  preferred?: readonly ModelSelection[],
): ModelSelection {
  const from = accounts.find((candidate) => candidate.instanceId === selection.instanceId);
  return from?.driverKind === account.driverKind
    ? { ...selection, instanceId: account.instanceId }
    : { instanceId: account.instanceId, model: chosenModelOn(account, accounts, preferred) ?? account.defaultModel ?? account.models[0] ?? selection.model };
}

const ENGINE_NAMES: Readonly<Record<string, string>> = { claudeAgent: "Claude", codex: "Codex" };

export function engineName(driverKind: string): string {
  return ENGINE_NAMES[driverKind] ?? driverKind;
}

export function crossEngineNotice(
  from: BatteryAccount | undefined,
  to: BatteryAccount | undefined,
  verb: "Continuing" | "Running",
): string | undefined {
  if (!from || !to || from.driverKind === to.driverKind) return undefined;
  return `${engineName(from.driverKind)} is recharging. ${verb} on ${engineName(to.driverKind)}.`;
}

export function pickAccount(input: PickInput): BatteryAccount | undefined {
  const { config, selection, accounts } = input;
  if (!batteryEnabled(config, accounts)) return undefined;
  const own = accounts.find((account) => account.instanceId === selection.instanceId);
  if (!own?.eligible) return undefined;
  const choice = decideAccount({
    chosen: selection, accounts, keepGoing: true, resting: input.resting, now: input.now, order: batterySequence(input),
    ...(input.usage ? { usage: input.usage } : {}), ...(input.preferred ? { preferred: input.preferred } : {}),
  });
  return choice.kind === "waiting" ? undefined : accounts.find((account) => account.instanceId === choice.run.instanceId);
}

export function routeSelection(input: Parameters<typeof pickAccount>[0]): ModelSelection {
  const account = pickAccount(input);
  return !account || account.instanceId === input.selection.instanceId
    ? input.selection
    : selectionOnAccount(input.selection, account, input.accounts, input.preferred);
}

export function checkBatteryConfig(
  patch: AccountBatteryPatch,
  accounts: readonly BatteryAccount[],
  current?: AccountBatteryConfig,
): { ok: true; config: AccountBatteryConfig } | { ok: false; error: string } {
  let order = current?.order ?? {};
  if (patch.order !== undefined) {
    order = {};
    for (const [driver, ids] of Object.entries(patch.order)) {
      if (!BATTERY_DRIVERS.includes(driver)) return { ok: false, error: "The token battery works with Claude and Codex accounts only." };
      const unknown = ids.find((id) => !accounts.some((account) => account.instanceId === id && account.driverKind === driver && account.eligible));
      if (unknown !== undefined) return { ok: false, error: `“${unknown}” is not an eligible subscription account here. Refresh the list and try again.` };
      order[driver] = [...new Set(ids)];
    }
  }
  const sequence = patch.sequence ?? current?.sequence;
  if (sequence?.some((id) => !accounts.some((account) => account.instanceId === id && account.eligible))) {
    return { ok: false, error: "An account in this order is unavailable. Refresh the list and try again." };
  }
  const auto = patch.auto ?? current?.auto;
  return { ok: true, config: { enabled: patch.enabled ?? batteryEnabled(current, accounts), order, ...(auto === undefined ? {} : { auto }), ...(sequence === undefined ? {} : { sequence: [...new Set(sequence)] }) } };
}

export function withoutAccount(config: AccountBatteryConfig | undefined, instanceId: string): AccountBatteryConfig | undefined {
  if (!config || (!Object.values(config.order ?? {}).some((ids) => ids.includes(instanceId)) && !config.sequence?.includes(instanceId))) return undefined;
  return {
    enabled: config.enabled,
    order: Object.fromEntries(Object.entries(config.order).map(([driver, ids]) => [driver, ids.filter((id) => id !== instanceId)])),
    ...(config.auto === undefined ? {} : { auto: config.auto }),
    ...(config.sequence === undefined ? {} : { sequence: config.sequence.filter((id) => id !== instanceId) }),
  };
}

export function planResetAt(row: PlanProviderRow | undefined, kind: string | undefined, now: number): string | undefined {
  if (!row?.ok) return undefined;
  const windows = [
    { name: "session", usedPercent: row.fiveHour.usedPercent, resetsAt: row.fiveHour.resetsAt },
    { name: "weekly", usedPercent: row.weekly.usedPercent, resetsAt: row.weekly.resetsAt },
    ...row.extra.map((extra) => ({ name: extra.label.toLowerCase(), usedPercent: extra.usedPercent, resetsAt: extra.resetsAt })),
    ...row.models.flatMap((model) => model.windows.map((window) => ({
      name: `${model.name} ${window.label}`.toLowerCase(), usedPercent: window.usedPercent, resetsAt: window.resetsAt,
    }))),
  ].filter((window) => window.resetsAt && Date.parse(window.resetsAt) > now);
  const named = kind ? windows.find((window) => window.name.includes(kind.toLowerCase())) : undefined;
  if (named?.resetsAt) return resetInstant(named.resetsAt, now);
  const full = windows.filter((window) => (window.usedPercent ?? 0) >= USED_UP_PERCENT).map((window) => window.resetsAt!).sort();
  return full.length ? resetInstant(full.at(-1), now) : undefined;
}

export function resetLabel(until: string, now: number, timeZone?: string): string {
  const { day, time } = resetParts(until, now, timeZone);
  return day ? `${day}, ${time}` : time;
}

function resetPhrase(until: string, now: number, timeZone?: string): string {
  const { day, time } = resetParts(until, now, timeZone);
  return day ? `${day} at ${time}` : `at ${time}`;
}

function resetParts(until: string, now: number, timeZone?: string): { day?: string; time: string } {
  const at = new Date(until);
  const plain = (text: string) => text.replace(/[\u202f\u00a0]/g, " ");
  const date = (value: Date) => new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).format(value);
  const time = plain(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(at));
  if (date(at) === date(new Date(now))) return { time };
  return { day: plain(new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(at)), time };
}

export function limitRowToReplace<M extends { id: string; role: string; kind: string; tool?: { name?: string; ok?: boolean } }>(
  path: readonly M[], requestMessageId: string | undefined,
): M | null {
  if (!requestMessageId) return null;
  const start = path.findIndex((message) => message.id === requestMessageId);
  if (start === -1) return null;
  return path.slice(start + 1).findLast((message) => message.role === "bot" && message.kind === "activity" &&
    message.tool?.ok === false && (message.tool.name ?? "").startsWith("error:")) ?? null;
}

const LIMIT_NAMES: ReadonlyMap<string, string> = new Map([
  ["session", "5-hour"], ["daily", "daily"], ["weekly", "weekly"], ["monthly", "monthly"], ["opus", "Opus"], ["sonnet", "Sonnet"],
]);

export function switchNotice(input: { to: string; from: string; rest?: Rest; now: number; timeZone?: string }): string {
  const { to, from, rest, now, timeZone } = input;
  if (rest?.kind === SETUP_STOP) return `Switched to ${to} — ${from} needs signing in again.`;
  const limit = rest?.kind ? LIMIT_NAMES.get(rest.kind) : undefined;
  const known = rest && !rest.estimated && Date.parse(rest.until) > now ? rest.until : undefined;
  if (limit) return `Switched to ${to} — ${from} hit its ${limit} limit${known ? `, resets ${resetPhrase(known, now, timeZone)}` : ""}.`;
  return `Switched to ${to} — ${from} is out of usage${known ? ` until ${resetLabel(known, now, timeZone)}` : " for now"}.`;
}

export function routedNotice(input: { to: string; from: string; rest?: Rest; why?: "signedOut" | "off"; now: number; timeZone?: string }): string {
  const { to, from, rest, now, timeZone } = input;
  if (rest?.kind === SETUP_STOP && Date.parse(rest.until) > now) return `Running on ${to} — ${from} needs signing in again.`;
  if (rest && Date.parse(rest.until) > now) {
    return rest.estimated
      ? `Running on ${to} — ${from} is recharging, back around ${resetLabel(rest.until, now, timeZone)}.`
      : `Running on ${to} — ${from} is recharging, back ${resetPhrase(rest.until, now, timeZone)}.`;
  }
  if (input.why === "signedOut") return `Running on ${to} — ${from} isn't signed in.`;
  if (input.why === "off") return `Running on ${to} — ${from} is turned off.`;
  return `Running on ${to} instead of ${from}.`;
}

export function backNotice(name: string): string {
  return `Back on ${name}.`;
}

export function carryOnNotice(name: string): string {
  return `Picking up where it stopped, on ${name}.`;
}

export interface AccountBatteryOptions {
  config: () => AccountBatteryConfig | undefined;
  accounts?: () => readonly BatteryAccount[];
  preferred?: (threadId: string | undefined) => readonly ModelSelection[] | undefined;
  file?: string;
  now?: () => number;
  planReset?: (instanceId: string, kind: string | undefined) => Promise<string | undefined>;
  usage?: PlanReading;
  usageAt?: (instanceId: string) => number | undefined;
  refreshUsage?: () => Promise<void>;
  onChange?: () => void;
}

const restingKey = (resting: Readonly<Record<string, Rest>>) =>
  JSON.stringify(Object.entries(resting).map(([id, rest]) => [id, rest.until]).sort());

export class AccountBattery {
  private state: BatteryState;
  private readonly turns = new Map<string, BatteryTurn>();
  private readonly now: () => number;
  private readonly options: AccountBatteryOptions;
  private shownOrder = "";
  private shownResting = "[]";
  private refreshing: Promise<void> | undefined;

  constructor(options: AccountBatteryOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.state = readState(options.file);
  }

  get enabled(): boolean {
    return batteryEnabled(this.options.config(), this.options.accounts?.() ?? []);
  }

  routes(threadId?: string): boolean {
    return this.enabled || Boolean(threadId && this.state.away[threadId]?.to);
  }

  preferredFor(threadId: string | undefined): readonly ModelSelection[] | undefined {
    return this.options.preferred?.(threadId);
  }

  route(selection: ModelSelection, accounts: readonly BatteryAccount[], threadId?: string): ModelSelection {
    this.dropDisprovedRests();
    return this.decide(selection, accounts, threadId).run;
  }

  decide(selection: ModelSelection, accounts: readonly BatteryAccount[], threadId?: string): AccountChoice {
    return decideAccount(this.choiceInput(selection, accounts, threadId));
  }

  private choiceInput(selection: ModelSelection, accounts: readonly BatteryAccount[], threadId: string | undefined): AccountChoiceInput {
    const preferred = this.preferredFor(threadId);
    const handPicked = threadId ? this.chosen(threadId, selection, accounts) : undefined;
    const resting = this.resting(accounts);
    const current = threadId ? this.state.away[threadId]?.on ?? this.state.ran[threadId]?.on : undefined;
    return {
      chosen: selection, accounts, keepGoing: this.enabled, resting, now: this.now(),
      order: batterySequence({ config: this.options.config(), accounts, resting, now: this.now() }),
      ...(this.options.usage ? { usage: this.options.usage } : {}), ...(current ? { current } : {}),
      ...(handPicked ? { handPicked } : {}), ...(preferred ? { preferred } : {}),
    };
  }

  choose(threadId: string, ranOut: string, to: string, pick: string): void {
    const away = this.state.away[threadId];
    this.state.away[threadId] = { from: away?.from ?? ranOut, at: new Date(this.now()).toISOString(), to, ranOut, pick, on: to };
    this.save();
  }

  chosen(threadId: string, selection: ModelSelection, accounts: readonly BatteryAccount[]): string | undefined {
    const away = this.state.away[threadId];
    if (!away?.to || !away.ranOut || (away.pick !== undefined && away.pick !== selection.instanceId)) return undefined;
    const ranOut = accounts.find((account) => account.instanceId === away.ranOut);
    if (!ranOut || !this.restOf(ranOut, accounts, selectionOnAccount(selection, ranOut, accounts, this.preferredFor(threadId)).model)) return undefined;
    return away.to;
  }

  markExhausted(instanceId: string, quota: Quota = {}): Rest {
    const now = this.now();
    const reported = resetInstant(quota.resetsAt, now);
    const reset = reported && Date.parse(reported) > now ? reported : undefined;
    const kind = quota.kind && /^[a-z][a-z0-9_-]{0,39}$/i.test(quota.kind) ? quota.kind.toLowerCase() : undefined;
    const reading = quotaReading(this.options.usage?.(instanceId), kind);
    const rest: Rest = {
      until: reset ?? new Date(now + DEFAULT_REST_MS).toISOString(),
      ...(kind ? { kind } : {}),
      ...(reset ? {} : { estimated: true }),
      since: new Date(now).toISOString(),
      ...(reading ? { reading: reading.key } : {}),
    };
    this.state.resting[instanceId] = rest;
    this.save();
    if (!reset && this.enabled && this.options.planReset) void this.refine(instanceId, rest);
    return rest;
  }

  private async refine(instanceId: string, rest: Rest): Promise<void> {
    try {
      const found = resetInstant(await this.options.planReset!(instanceId, rest.kind), this.now());
      if (!found || this.state.resting[instanceId] !== rest) return;
      const { estimated: _estimated, ...known } = rest;
      this.state.resting[instanceId] = { ...known, until: found };
      this.save();
    } catch {}
  }

  recovered(instanceId: string, startedAt?: number): boolean {
    const rest = this.state.resting[instanceId];
    if (!rest) return false;
    if (startedAt === undefined ? !rest.estimated : startedAt < Date.parse(rest.since)) return false;
    delete this.state.resting[instanceId];
    this.save();
    return true;
  }

  forget(instanceId: string): void {
    let changed = Boolean(this.state.resting[instanceId]);
    delete this.state.resting[instanceId];
    for (const [threadId, placed] of Object.entries(this.state.placed)) {
      if (placed.on !== instanceId) continue;
      delete this.state.placed[threadId];
      changed = true;
    }
    for (const [threadId, ran] of Object.entries(this.state.ran)) {
      if (ran.on !== instanceId) continue;
      delete this.state.ran[threadId];
      changed = true;
    }
    for (const [threadId, away] of Object.entries(this.state.away)) {
      if (away.from === instanceId) delete this.state.away[threadId];
      else if (away.to === instanceId || away.ranOut === instanceId || away.on === instanceId) {
        this.state.away[threadId] = { from: away.from, at: away.at, ...(away.on && away.on !== instanceId ? { on: away.on } : {}) };
      } else continue;
      changed = true;
    }
    if (changed) this.save();
  }

  private dropDisprovedRests(): void {
    const disproved = readingsDisprove(this.state.resting, this.options.usage, this.options.usageAt, this.now());
    if (!disproved.length) return;
    for (const instanceId of disproved) delete this.state.resting[instanceId];
    this.save();
  }

  restOf(account: BatteryAccount, accounts: readonly BatteryAccount[], model?: string): (Rest & { sharedWith?: string }) | undefined {
    return activeRest(account, model, accounts, this.resting(accounts), this.now());
  }

  private resting(accounts: readonly BatteryAccount[]): Record<string, Rest> {
    return withReadings(this.state.resting, accounts, this.options.usage, this.now());
  }

  readyAt(selection: ModelSelection, accounts: readonly BatteryAccount[], threadId?: string): string | undefined {
    this.dropDisprovedRests();
    return choiceReadyAt(this.choiceInput(selection, accounts, threadId));
  }

  status(accounts: readonly BatteryAccount[], selectionOf?: (threadId: string) => ModelSelection | undefined, running: Iterable<readonly [string, Ran]> = []): BatteryStatus {
    const config = this.options.config();
    const resting: BatteryStatus["resting"] = {};
    for (const account of accounts) {
      if (!account.eligible) continue;
      const rest = this.restOf(account, accounts);
      if (rest) resting[account.instanceId] = rest;
    }
    const routed: BatteryStatus["routed"] = {};
    const fromNextMessage: BatteryStatus["fromNextMessage"] = {};
    if (selectionOf) {
      const ran = new Map<string, Ran>(Object.entries(this.state.ran).map(([threadId, last]) => [threadId, { on: last.on, model: last.model }]));
      for (const [threadId, now] of running) ran.set(threadId, now);
      for (const [threadId, last] of ran) {
        const chosen = selectionOf(threadId);
        const shown = chosen ? shownRoute(this.decide(chosen, accounts, threadId), chosen, last) : undefined;
        if (!shown) continue;
        const { next, ...route } = shown;
        (next ? fromNextMessage : routed)[threadId] = route;
      }
    }
    const order = effectiveOrder({ config, accounts, resting: this.resting(accounts), now: this.now(), usage: this.options.usage });
    const sequence = batterySequence({ config, accounts, resting: this.resting(accounts), now: this.now(), usage: this.options.usage });
    this.shownOrder = JSON.stringify({ order, sequence });
    this.shownResting = restingKey(resting);
    return { enabled: batteryEnabled(config, accounts), auto: config?.auto === true, order,
      sequence, resting, routed, fromNextMessage };
  }

  noteReadings(accounts: readonly BatteryAccount[]): void {
    this.dropDisprovedRests();
    const config = this.options.config();
    const resting = restingKey(Object.fromEntries(accounts.filter((account) => account.eligible)
      .flatMap((account) => { const rest = this.restOf(account, accounts); return rest ? [[account.instanceId, rest]] : []; })));
    if (resting !== this.shownResting) {
      this.shownResting = resting;
      this.options.onChange?.();
      return;
    }
    if (!batteryEnabled(config, accounts) || !config?.auto) return;
    const order = effectiveOrder({ config, accounts, resting: this.resting(accounts), now: this.now(), usage: this.options.usage });
    const sequence = batterySequence({ config, accounts, resting: this.resting(accounts), now: this.now(), usage: this.options.usage });
    if (JSON.stringify({ order, sequence }) !== this.shownOrder) this.options.onChange?.();
  }

  trackTurn(threadId: string, turn: BatteryTurn): void {
    this.turns.delete(threadId);
    this.turns.set(threadId, turn);
    if (this.turns.size > MAX_TURNS) this.turns.delete(this.turns.keys().next().value!);
  }

  pendingThreads(): string[] {
    return [...this.turns].filter(([, turn]) => turn.pending).map(([threadId]) => threadId);
  }

  pending(threadId: string, generation: string | undefined): boolean {
    return this.keptTurn(threadId, generation)?.pending === true;
  }

  pauseTurn(threadId: string, generation: string | undefined): boolean {
    const turn = this.keptTurn(threadId, generation);
    if (!turn?.rerun || !this.enabled) return false;
    turn.pending = true;
    return true;
  }

  nextAccount(input: {
    threadId: string;
    generation: string | undefined;
    stopReason: string | null | undefined;
    ranOn: string | undefined;
    selection: ModelSelection | undefined;
    accounts: readonly BatteryAccount[];
  }): BatteryRerun | null {
    const setup = input.stopReason === SETUP_STOP;
    if ((input.stopReason !== "usage_limit" && !setup) || !input.selection) return null;
    const turn = this.turns.get(input.threadId);
    const from = input.accounts.find((account) => account.instanceId === (input.ranOn ?? turn?.instanceId));
    const preferred = this.preferredFor(input.threadId);
    if (from && setup) this.needsSetup(from.instanceId);
    else if (from) this.ranOut(from, input.accounts, selectionOnAccount(input.selection, from, input.accounts, preferred).model);
    if (!turn?.rerun || turn.generation !== input.generation) return null;
    const choice = this.decide(input.selection, input.accounts, input.threadId);
    const to = choice.kind === "waiting" ? undefined : input.accounts.find((account) => account.instanceId === choice.run.instanceId);
    if (!from || !to || to.instanceId === from.instanceId) return null;
    return { turn, from, to, rest: this.restOf(from, input.accounts, input.selection.model), reason: setup ? SETUP_STOP : "usage_limit" };
  }

  needsSetup(instanceId: string): Rest {
    const existing = this.state.resting[instanceId];
    if (existing?.kind === SETUP_STOP && Date.parse(existing.until) > this.now()) return existing;
    const now = this.now();
    const rest: Rest = { until: new Date(now + SETUP_REST_MS).toISOString(), kind: SETUP_STOP, since: new Date(now).toISOString() };
    this.state.resting[instanceId] = rest;
    this.save();
    return rest;
  }

  ranOut(account: BatteryAccount, accounts: readonly BatteryAccount[], model: string): void {
    if (this.restOf(account, accounts, model)) return;
    this.markExhausted(account.instanceId);
    void this.freshenUsage(accounts);
  }

  async freshenUsage(accounts: readonly BatteryAccount[]): Promise<void> {
    const refresh = this.options.refreshUsage;
    if (!refresh || !this.enabled) return;
    const now = this.now();
    const stale = accounts.some((account) => account.eligible && account.enabled && account.signedIn !== false &&
      !this.restOf(account, accounts) && !((this.options.usageAt?.(account.instanceId) ?? Number.NEGATIVE_INFINITY) > now - USAGE_FRESH_MS));
    if (!stale) return;
    this.refreshing ??= refresh().catch(() => undefined).finally(() => { this.refreshing = undefined; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.refreshing, new Promise<void>((resolve) => { timer = setTimeout(resolve, USAGE_REFRESH_WAIT_MS); })]);
    clearTimeout(timer);
  }

  takeTurn(threadId: string, generation: string | undefined): BatteryTurn | undefined {
    const turn = this.keptTurn(threadId, generation);
    if (turn) this.turns.delete(threadId);
    return turn;
  }

  keptTurn(threadId: string, generation: string | undefined): BatteryTurn | undefined {
    const turn = this.turns.get(threadId);
    return turn && turn.generation === generation ? turn : undefined;
  }

  noteSwitch(threadId: string, from: string, to: string): void {
    const away = this.state.away[threadId];
    if (away?.from === to) delete this.state.away[threadId];
    else this.state.away[threadId] = away ? { ...away, on: to } : { from, at: new Date(this.now()).toISOString(), on: to };
    this.save();
  }

  arrive(threadId: string, selection: ModelSelection, ranOn: string, accounts: readonly BatteryAccount[]): string | undefined {
    const find = (instanceId: string) => accounts.find((account) => account.instanceId === instanceId);
    const name = (instanceId: string) => find(instanceId)?.displayName || instanceId;
    const away = this.state.away[threadId];
    this.place(threadId, ranOn === selection.instanceId ? ranOn : undefined, selection.instanceId);
    if (ranOn === selection.instanceId) {
      if (this.takeBack(threadId, ranOn)) return backNotice(name(ranOn));
      if (away?.on !== undefined) {
        const { on: _on, ...kept } = away;
        this.state.away[threadId] = kept;
        this.save();
      }
      return undefined;
    }
    if (away?.on === ranOn) return undefined;
    this.state.away[threadId] = away?.from === selection.instanceId
      ? { ...away, on: ranOn }
      : { from: selection.instanceId, at: new Date(this.now()).toISOString(), on: ranOn };
    this.save();
    const from = find(selection.instanceId);
    const rest = from ? this.restOf(from, accounts, selection.model) : undefined;
    const engines = rest && Date.parse(rest.until) > this.now() ? crossEngineNotice(from, find(ranOn), "Running") : undefined;
    return engines ?? routedNotice({
      to: name(ranOn), from: name(selection.instanceId), rest,
      why: from?.signedIn === false ? "signedOut" : from && !from.enabled ? "off" : undefined, now: this.now(),
    });
  }

  private place(threadId: string, on: string | undefined, from: string): void {
    const placed = this.state.placed[threadId];
    if (placed?.on === on && placed?.from === from) return;
    if (on === undefined) delete this.state.placed[threadId];
    else this.state.placed[threadId] = { on, at: new Date(this.now()).toISOString(), from };
    const all = Object.entries(this.state.placed);
    if (all.length > MAX_PLACED) {
      all.sort((a, b) => a[1].at.localeCompare(b[1].at));
      for (const [oldest] of all.slice(0, all.length - MAX_PLACED)) delete this.state.placed[oldest];
    }
    this.persist();
  }

  noteRan(threadId: string, on: string, model: string): void {
    const last = this.state.ran[threadId];
    if (last?.on === on && last.model === model) return;
    this.state.ran[threadId] = { on, model, at: new Date(this.now()).toISOString() };
    const all = Object.entries(this.state.ran);
    if (all.length > MAX_RAN) {
      all.sort((a, b) => a[1].at.localeCompare(b[1].at));
      for (const [oldest] of all.slice(0, all.length - MAX_RAN)) delete this.state.ran[oldest];
    }
    this.save();
  }

  release(threadId: string): void {
    if (!this.state.away[threadId] && !this.state.placed[threadId]) return;
    delete this.state.away[threadId];
    delete this.state.placed[threadId];
    this.save();
  }

  pin(threadId: string, instanceId: string): void {
    delete this.state.away[threadId];
    this.place(threadId, instanceId, instanceId);
    this.save();
  }

  takeBack(threadId: string, instanceId: string): boolean {
    if (this.state.away[threadId]?.from !== instanceId) return false;
    delete this.state.away[threadId];
    this.save();
    return true;
  }

  private save(): void {
    const now = this.now();
    for (const [id, rest] of Object.entries(this.state.resting)) {
      if (!(Date.parse(rest.until) > now)) delete this.state.resting[id];
    }
    const away = Object.entries(this.state.away);
    if (away.length > MAX_AWAY) {
      away.sort((a, b) => a[1].at.localeCompare(b[1].at));
      for (const [threadId] of away.slice(0, away.length - MAX_AWAY)) delete this.state.away[threadId];
    }
    this.persist();
    this.options.onChange?.();
  }

  private persist(): void {
    if (!this.options.file) return;
    try {
      writeFileAtomic(this.options.file, JSON.stringify(this.state), { mode: 0o600, durable: false });
    } catch (error) {
      console.warn(`token battery: could not save ${this.options.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
