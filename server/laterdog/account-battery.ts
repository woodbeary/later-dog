import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import type { PlanProviderRow } from "../plan-usage.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import { resetInstant } from "./usage-limit.ts";
import { homeAccount, leastLoaded } from "./account-spread.ts";

export const BATTERY_DRIVERS: readonly string[] = ["claudeAgent", "codex"];

export const DEFAULT_REST_MS = 5 * 60 * 60 * 1000;
const MAX_AWAY = 500;
const MAX_TURNS = 2_000;
const MAX_PLACED = 2_000;

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
}

export interface BatteryStatus {
  enabled: boolean;
  auto: boolean;
  order: Record<string, string[]>;
  sequence: string[];
  resting: Record<string, Rest & { sharedWith?: string }>;
  routed: Record<string, { from: string; on: string }>;
}

const restSchema = z.object({
  until: z.string().max(64),
  kind: z.string().max(40).optional(),
  estimated: z.boolean().optional(),
  since: z.string().max(64),
});
const stateSchema = z.object({
  version: z.literal(1),
  resting: z.record(z.string(), restSchema).default({}),
  away: z.record(z.string(), z.object({
    from: z.string(), at: z.string(), to: z.string().optional(), ranOut: z.string().optional(), pick: z.string().optional(), on: z.string().optional(),
  })).default({}),
  placed: z.record(z.string(), z.object({ on: z.string(), at: z.string() })).default({}),
});
type BatteryState = z.output<typeof stateSchema>;

const emptyState = (): BatteryState => ({ version: 1, resting: {}, away: {}, placed: {} });

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
      return Number(x.asleep) - Number(y.asleep) || Number(x.left === undefined) - Number(y.left === undefined) ||
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

function canTake(account: BatteryAccount | undefined, input: Omit<PickInput, "config">, listed: boolean): account is BatteryAccount {
  if (!account?.eligible || !account.enabled || account.signedIn === false) return false;
  const own = input.accounts.find((candidate) => candidate.instanceId === input.selection.instanceId);
  if (account.driverKind === own?.driverKind && listed && !account.models.includes(input.selection.model)) return false;
  if (account.driverKind !== own?.driverKind && !account.defaultModel && !account.models.length) return false;
  return !activeRest(account, selectionOnAccount(input.selection, account, input.accounts, input.preferred).model, input.accounts, input.resting, input.now);
}

export function pickAccount(input: PickInput): BatteryAccount | undefined {
  const { config, selection, accounts } = input;
  if (!batteryEnabled(config, accounts)) return undefined;
  const own = accounts.find((account) => account.instanceId === selection.instanceId);
  if (!own?.eligible) return undefined;
  const order = batterySequence(input);
  const listed = own.models.includes(selection.model);
  for (const id of [own.instanceId, ...order.filter((id) => id !== own.instanceId)]) {
    const account = accounts.find((candidate) => candidate.instanceId === id);
    if (canTake(account, input, listed)) return account;
  }
  return undefined;
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
  const full = windows.filter((window) => (window.usedPercent ?? 0) >= 99.5).map((window) => window.resetsAt!).sort();
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
  const limit = rest?.kind ? LIMIT_NAMES.get(rest.kind) : undefined;
  const known = rest && !rest.estimated && Date.parse(rest.until) > now ? rest.until : undefined;
  if (limit) return `Switched to ${to} — ${from} hit its ${limit} limit${known ? `, resets ${resetPhrase(known, now, timeZone)}` : ""}.`;
  return `Switched to ${to} — ${from} is out of usage${known ? ` until ${resetLabel(known, now, timeZone)}` : " for now"}.`;
}

export function routedNotice(input: { to: string; from: string; rest?: Rest; why?: "signedOut" | "off"; now: number; timeZone?: string }): string {
  const { to, from, rest, now, timeZone } = input;
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
  running?: () => Readonly<Record<string, number>>;
  defaultAccount?: () => string | undefined;
  ownThread?: (threadId: string) => boolean;
  onChange?: () => void;
}

export class AccountBattery {
  private state: BatteryState;
  private readonly turns = new Map<string, BatteryTurn>();
  private readonly now: () => number;
  private readonly options: AccountBatteryOptions;
  private shownOrder = "";

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
    const preferred = this.preferredFor(threadId);
    const chosen = threadId ? this.chosen(threadId, selection, accounts) : undefined;
    if (chosen) return selectionOnAccount(selection, accounts.find((account) => account.instanceId === chosen)!, accounts, preferred);
    const input = { selection, accounts, resting: this.state.resting, now: this.now(), usage: this.options.usage, ...(preferred ? { preferred } : {}) };
    const own = accounts.find((account) => account.instanceId === selection.instanceId);
    if (!own?.eligible) return selection;
    const spread = threadId ? this.spreadTo(threadId, own, input) : undefined;
    if (spread && spread.instanceId !== own.instanceId) return selectionOnAccount(selection, spread, accounts, preferred);
    if (spread || canTake(own, input, false)) return selection;
    return routeSelection({ config: this.options.config(), ...input });
  }

  private pinned(own: BatteryAccount, accounts: readonly BatteryAccount[]): boolean {
    const order = batteryOrder(this.options.config(), accounts)[own.driverKind] ?? [];
    return own.instanceId !== homeAccount(order, this.options.defaultAccount?.());
  }

  private spreadTo(threadId: string, own: BatteryAccount, input: Omit<PickInput, "config">): BatteryAccount | undefined {
    const running = this.options.running?.();
    if (!running || !this.enabled || this.options.ownThread?.(threadId) === false || this.pinned(own, input.accounts)) return undefined;
    const order = batteryOrder(this.options.config(), input.accounts)[own.driverKind] ?? [];
    const listed = own.models.includes(input.selection.model);
    const candidates = input.accounts.filter((account) => account.driverKind === own.driverKind && order.includes(account.instanceId) &&
      canTake(account, input, listed));
    const away = this.state.away[threadId];
    const kept = candidates.find((account) => account.instanceId === this.state.placed[threadId]?.on) ??
      (away ? candidates.find((account) => account === own) ?? candidates.find((account) => account.instanceId === away.on) : undefined);
    if (kept) return kept;
    const load = (account: BatteryAccount) => input.accounts
      .filter((other) => other.instanceId === account.instanceId || sameLogin(account, other))
      .reduce((sum, other) => sum + (running[other.instanceId] ?? 0), 0);
    const pick = leastLoaded(candidates.map((account) => ({
      instanceId: account.instanceId, own: account === own, running: load(account),
      left: percentLeft(input.usage?.(account.instanceId), input.now), index: order.indexOf(account.instanceId),
    })));
    return candidates.find((account) => account.instanceId === pick);
  }

  private spreadMove(selection: ModelSelection, ranOn: string, accounts: readonly BatteryAccount[]): boolean {
    const own = accounts.find((account) => account.instanceId === selection.instanceId);
    const to = accounts.find((account) => account.instanceId === ranOn);
    if (!own?.eligible || !to || to.driverKind !== own.driverKind || !this.options.running || this.pinned(own, accounts)) return false;
    return canTake(own, { selection, accounts, resting: this.state.resting, now: this.now() }, false);
  }

  choose(threadId: string, ranOut: string, to: string, pick: string): void {
    const away = this.state.away[threadId];
    this.state.away[threadId] = { from: away?.from ?? ranOut, at: new Date(this.now()).toISOString(), to, ranOut, pick, on: to };
    this.save();
  }

  chosen(threadId: string, selection: ModelSelection, accounts: readonly BatteryAccount[]): string | undefined {
    const away = this.state.away[threadId];
    if (!away?.to || !away.ranOut || (away.pick !== undefined && away.pick !== selection.instanceId)) return undefined;
    const find = (instanceId: string) => accounts.find((account) => account.instanceId === instanceId);
    const own = find(selection.instanceId);
    const ranOut = find(away.ranOut);
    const to = find(away.to);
    if (!own?.eligible || !ranOut || !to?.eligible || !to.enabled || to.signedIn === false) return undefined;
    if (to.driverKind === own.driverKind && own.models.includes(selection.model) && !to.models.includes(selection.model)) return undefined;
    const preferred = this.preferredFor(threadId);
    if (!this.restOf(ranOut, accounts, selectionOnAccount(selection, ranOut, accounts, preferred).model) ||
        this.restOf(to, accounts, selectionOnAccount(selection, to, accounts, preferred).model)) return undefined;
    return to.instanceId;
  }

  markExhausted(instanceId: string, quota: Quota = {}): Rest {
    const now = this.now();
    const reported = resetInstant(quota.resetsAt, now);
    const reset = reported && Date.parse(reported) > now ? reported : undefined;
    const kind = quota.kind && /^[a-z][a-z0-9_-]{0,39}$/i.test(quota.kind) ? quota.kind.toLowerCase() : undefined;
    const rest: Rest = {
      until: reset ?? new Date(now + DEFAULT_REST_MS).toISOString(),
      ...(kind ? { kind } : {}),
      ...(reset ? {} : { estimated: true }),
      since: new Date(now).toISOString(),
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
    for (const [threadId, away] of Object.entries(this.state.away)) {
      if (away.from === instanceId) delete this.state.away[threadId];
      else if (away.to === instanceId || away.ranOut === instanceId || away.on === instanceId) {
        this.state.away[threadId] = { from: away.from, at: away.at, ...(away.on && away.on !== instanceId ? { on: away.on } : {}) };
      } else continue;
      changed = true;
    }
    if (changed) this.save();
  }

  restOf(account: BatteryAccount, accounts: readonly BatteryAccount[], model?: string): (Rest & { sharedWith?: string }) | undefined {
    return activeRest(account, model, accounts, this.state.resting, this.now());
  }

  readyAt(selection: ModelSelection, accounts: readonly BatteryAccount[], threadId?: string): string | undefined {
    const find = (instanceId: string) => accounts.find((account) => account.instanceId === instanceId);
    const own = find(selection.instanceId);
    if (!own) return undefined;
    const away = threadId ? this.state.away[threadId] : undefined;
    const listed = own.models.includes(selection.model);
    const others = [
      ...(away?.to && (away.pick === undefined || away.pick === own.instanceId) ? [away.to] : []),
      ...(this.enabled && own.eligible ? batterySequence({ config: this.options.config(), accounts, resting: this.state.resting, now: this.now() }) : []),
    ].map(find).filter((account): account is BatteryAccount => Boolean(account && account !== own && account.eligible && account.enabled &&
      account.signedIn !== false && (account.driverKind !== own.driverKind ? Boolean(account.defaultModel || account.models.length) : !listed || account.models.includes(selection.model))));
    let soonest = Infinity;
    const preferred = this.preferredFor(threadId);
    for (const account of [own, ...others]) {
      const rest = this.restOf(account, accounts, selectionOnAccount(selection, account, accounts, preferred).model);
      if (!rest) return undefined;
      soonest = Math.min(soonest, Date.parse(rest.until));
    }
    return new Date(soonest).toISOString();
  }

  status(accounts: readonly BatteryAccount[]): BatteryStatus {
    const config = this.options.config();
    const resting: BatteryStatus["resting"] = {};
    for (const account of accounts) {
      if (!account.eligible) continue;
      const rest = this.restOf(account, accounts);
      if (rest) resting[account.instanceId] = rest;
    }
    const routed: BatteryStatus["routed"] = {};
    for (const [threadId, away] of Object.entries(this.state.away)) {
      const from = away.on && away.on !== away.from ? accounts.find((account) => account.instanceId === away.from) : undefined;
      if (from && (!from.enabled || from.signedIn === false || this.restOf(from, accounts))) routed[threadId] = { from: away.from, on: away.on! };
    }
    const order = effectiveOrder({ config, accounts, resting: this.state.resting, now: this.now(), usage: this.options.usage });
    const sequence = batterySequence({ config, accounts, resting: this.state.resting, now: this.now(), usage: this.options.usage });
    this.shownOrder = JSON.stringify({ order, sequence });
    return { enabled: batteryEnabled(config, accounts), auto: config?.auto === true, order,
      sequence, resting, routed };
  }

  noteReadings(accounts: readonly BatteryAccount[]): void {
    const config = this.options.config();
    if (!batteryEnabled(config, accounts) || !config?.auto) return;
    const order = effectiveOrder({ config, accounts, resting: this.state.resting, now: this.now(), usage: this.options.usage });
    const sequence = batterySequence({ config, accounts, resting: this.state.resting, now: this.now(), usage: this.options.usage });
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
    if (input.stopReason !== "usage_limit" || !input.selection) return null;
    const turn = this.turns.get(input.threadId);
    const from = input.accounts.find((account) => account.instanceId === (input.ranOn ?? turn?.instanceId));
    const preferred = this.preferredFor(input.threadId);
    if (from) this.ranOut(from, input.accounts, selectionOnAccount(input.selection, from, input.accounts, preferred).model);
    if (!turn?.rerun || turn.generation !== input.generation) return null;
    const to = pickAccount({
      config: this.options.config(), selection: input.selection, accounts: input.accounts, resting: this.state.resting, now: this.now(), usage: this.options.usage,
      ...(preferred ? { preferred } : {}),
    });
    if (!from || !to || to.instanceId === from.instanceId) return null;
    return { turn, from, to, rest: this.restOf(from, input.accounts, input.selection.model) };
  }

  ranOut(account: BatteryAccount, accounts: readonly BatteryAccount[], model: string): void {
    if (!this.restOf(account, accounts, model)) this.markExhausted(account.instanceId);
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
    const spread = ranOn !== selection.instanceId && away === undefined &&
      (this.state.placed[threadId]?.on === ranOn || this.spreadMove(selection, ranOn, accounts));
    this.place(threadId, ranOn === selection.instanceId || spread ? ranOn : undefined);
    if (spread) return undefined;
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

  private place(threadId: string, on: string | undefined): void {
    const placed = this.state.placed[threadId];
    if (placed?.on === on) return;
    if (on === undefined) delete this.state.placed[threadId];
    else this.state.placed[threadId] = { on, at: new Date(this.now()).toISOString() };
    const all = Object.entries(this.state.placed);
    if (all.length > MAX_PLACED) {
      all.sort((a, b) => a[1].at.localeCompare(b[1].at));
      for (const [oldest] of all.slice(0, all.length - MAX_PLACED)) delete this.state.placed[oldest];
    }
    this.persist();
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
