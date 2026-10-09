import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import type { PlanProviderRow } from "../plan-usage.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import { resetInstant } from "./usage-limit.ts";

/** Engines whose driver reports a reached usage limit (runtime.error.quota). */
export const BATTERY_DRIVERS: readonly string[] = ["claudeAgent", "codex"];

/** How long an account rests when nothing says when its limit resets: the
 * length of Claude's session window. */
export const DEFAULT_REST_MS = 5 * 60 * 60 * 1000;
/** Conversations remembered as switched away from an account. */
const MAX_AWAY = 500;
/** Turns remembered for a possible re-run (one per conversation). */
const MAX_TURNS = 2_000;

/** The prompt a backup account gets when the failed attempt already used a
 * tool: the request again could repeat work that has happened. */
export const CONTINUE_AFTER_SWITCH =
  "[later.dog: the account this conversation was running on reached its usage limit partway through your last turn, " +
  "so it continues on another account. Anything that turn already did (files written, commands run) is still in place, " +
  "but its tool results are not in this session. Check the current state, then continue the user's last request from " +
  "where it stopped. Do not redo what was already done.]";

export interface AccountBatteryConfig {
  enabled: boolean;
  /** Per engine (driver kind): account instance ids, favourite first. */
  order: Record<string, string[]>;
}

/** One account as the battery sees it, from the registry's last read. */
export interface BatteryAccount {
  instanceId: string;
  driverKind: string;
  displayName?: string;
  enabled: boolean;
  /** Whether the battery may use it at all: a personal subscription login of
   * an engine in BATTERY_DRIVERS — not an API key, router or company engine. */
  eligible: boolean;
  /** Unknown until the engine has been read once; as for a thread's own
   * engine, only what is known stops a pick. */
  signedIn?: boolean;
  /** The provider login behind the account. Two accounts signed in to one
   * login share one limit, so they rest together. */
  email?: string;
  /** Model ids its catalog lists. */
  models: readonly string[];
}

export interface Rest {
  /** ISO time the limit resets. */
  until: string;
  /** session, weekly, opus, sonnet… when the provider said which limit. */
  kind?: string;
  /** No reset time was reported or found: `until` is an estimate. */
  estimated?: boolean;
  /** When the limit was reported. */
  since: string;
}

/** What a runtime error says about a reached limit. */
export interface Quota {
  resetsAt?: string;
  kind?: string;
}

/** A dispatched direct turn, kept so it can run once more elsewhere. */
export interface BatteryTurn {
  /** The dispatch generation that owns the conversation. */
  generation: string;
  /** The account it was dispatched on. */
  instanceId: string;
  /** The person's message it answers; a re-run is dropped once a newer one
   * arrives. */
  requestMessageId?: string;
  /** Starts the turn again: the same message when `continuation` is null,
   * else that prompt. Absent for a turn that must not run twice (a backup
   * attempt already, a routine run, coordinated or delegated work). */
  rerun?: (continuation: string | null) => Promise<unknown>;
}

export interface BatteryRerun {
  turn: BatteryTurn;
  from: BatteryAccount;
  to: BatteryAccount;
  rest?: Rest;
}

export interface BatteryStatus {
  enabled: boolean;
  /** The order turns use: the saved one, then any account added since. */
  order: Record<string, string[]>;
  /** Accounts resting now; `sharedWith` names the account whose limit it
   * shares (the same login). */
  resting: Record<string, Rest & { sharedWith?: string }>;
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
  away: z.record(z.string(), z.object({ from: z.string(), at: z.string(), to: z.string().optional(), ranOut: z.string().optional(), pick: z.string().optional() })).default({}),
});
type BatteryState = z.output<typeof stateSchema>;

const emptyState = (): BatteryState => ({ version: 1, resting: {}, away: {} });

function readState(file: string | undefined): BatteryState {
  if (!file || !existsSync(file)) return emptyState();
  try {
    const parsed = stateSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : emptyState();
  } catch {
    return emptyState();
  }
}

/** The order turns use, per engine: the saved order (accounts that are
 * still eligible), then every eligible account it does not name yet. */
export function batteryOrder(config: AccountBatteryConfig | undefined, accounts: readonly BatteryAccount[]): Record<string, string[]> {
  const order: Record<string, string[]> = {};
  for (const driver of BATTERY_DRIVERS) {
    const eligible = accounts.filter((account) => account.driverKind === driver && account.eligible).map((account) => account.instanceId);
    const saved = (config?.order?.[driver] ?? []).filter((id) => eligible.includes(id));
    order[driver] = [...new Set([...saved, ...eligible])];
  }
  return order;
}

/** Whether a rest keeps an account from `model` now. A model-scoped limit
 * (Opus, Sonnet) only stops that family; without a model, any rest counts. */
export function restApplies(rest: Rest | undefined, model: string | undefined, now: number): boolean {
  if (!rest || !(Date.parse(rest.until) > now)) return false;
  if (model === undefined) return true;
  if (rest.kind === "opus") return /opus/i.test(model);
  if (rest.kind === "sonnet") return /sonnet/i.test(model);
  return true;
}

const sameLogin = (a: BatteryAccount, b: BatteryAccount) =>
  Boolean(a.email && b.email && a.email.trim().toLowerCase() === b.email.trim().toLowerCase());

/** The rest keeping `account` from `model`: its own, or that of another
 * account signed in to the same login. */
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
}

function canTake(account: BatteryAccount | undefined, input: Omit<PickInput, "config">, listed: boolean): account is BatteryAccount {
  if (!account?.eligible || !account.enabled || account.signedIn === false) return false;
  if (listed && !account.models.includes(input.selection.model)) return false;
  return !activeRest(account, input.selection.model, input.accounts, input.resting, input.now);
}

export function pickAccount(input: PickInput): BatteryAccount | undefined {
  const { config, selection, accounts } = input;
  if (!config?.enabled) return undefined;
  const own = accounts.find((account) => account.instanceId === selection.instanceId);
  if (!own?.eligible) return undefined;
  const order = batteryOrder(config, accounts)[own.driverKind] ?? [];
  const listed = own.models.includes(selection.model);
  for (const id of [own.instanceId, ...order.filter((id) => id !== own.instanceId)]) {
    const account = accounts.find((candidate) => candidate.instanceId === id);
    if (canTake(account, input, listed)) return account;
  }
  return undefined;
}

/** `selection` with the account the battery picks; the same object when it
 * picks none or the one already named. */
export function routeSelection(input: Parameters<typeof pickAccount>[0]): ModelSelection {
  const account = pickAccount(input);
  return !account || account.instanceId === input.selection.instanceId
    ? input.selection
    : { ...input.selection, instanceId: account.instanceId };
}

/** A saved battery setting, checked against the accounts there are: only
 * engines whose limits are reported, only their eligible accounts, each once. */
export function checkBatteryConfig(
  config: AccountBatteryConfig,
  accounts: readonly BatteryAccount[],
): { ok: true; config: AccountBatteryConfig } | { ok: false; error: string } {
  const order: Record<string, string[]> = {};
  for (const [driver, ids] of Object.entries(config.order ?? {})) {
    if (!BATTERY_DRIVERS.includes(driver)) return { ok: false, error: "The token battery works with Claude and Codex accounts only." };
    const unknown = ids.find((id) => !accounts.some((account) => account.instanceId === id && account.driverKind === driver && account.eligible));
    if (unknown !== undefined) return { ok: false, error: `“${unknown}” is not a Claude subscription account here. Refresh the list and try again.` };
    order[driver] = [...new Set(ids)];
  }
  return { ok: true, config: { enabled: config.enabled, order } };
}

/** The setting without a removed account, or undefined when it never named it. */
export function withoutAccount(config: AccountBatteryConfig | undefined, instanceId: string): AccountBatteryConfig | undefined {
  if (!config || !Object.values(config.order ?? {}).some((ids) => ids.includes(instanceId))) return undefined;
  return {
    enabled: config.enabled,
    order: Object.fromEntries(Object.entries(config.order).map(([driver, ids]) => [driver, ids.filter((id) => id !== instanceId)])),
  };
}

/** When the Usage page's reading of an account says its limit resets: the
 * window the error named, else the latest-resetting window that is full. */
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

/** The row a switch notice takes the place of: the failed-turn row (the
 * usage limit) that the request's attempt on the last account left, after
 * the request message. A limit the battery already handled is not something
 * to fix, so it reads as one calm notice instead of an error plus a notice.
 * Null when the request message is gone or no failed row follows it. */
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

/** The status line a conversation gets when it is back on that account. */
export function backNotice(name: string): string {
  return `Back on ${name}.`;
}

export interface AccountBatteryOptions {
  /** The saved setting (config.json `accountBattery`), read at each use. */
  config: () => AccountBatteryConfig | undefined;
  /** Where rests and switched conversations persist; memory only without. */
  file?: string;
  now?: () => number;
  /** Ask the provider when an account's limit resets, for an error that did
   * not say. Best effort: the estimate stands if it fails. */
  planReset?: (instanceId: string, kind: string | undefined) => Promise<string | undefined>;
  /** Rests changed: the Settings card shows them. */
  onChange?: () => void;
}

export class AccountBattery {
  private state: BatteryState;
  private readonly turns = new Map<string, BatteryTurn>();
  private readonly now: () => number;
  // A plain field: the server runs this file with Node's type stripping,
  // which has no parameter properties.
  private readonly options: AccountBatteryOptions;

  constructor(options: AccountBatteryOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.state = readState(options.file);
  }

  get enabled(): boolean {
    return this.options.config()?.enabled === true;
  }

  routes(threadId?: string): boolean {
    return this.enabled || Boolean(threadId && this.state.away[threadId]?.to);
  }

  route(selection: ModelSelection, accounts: readonly BatteryAccount[], threadId?: string): ModelSelection {
    const chosen = threadId ? this.chosen(threadId, selection, accounts) : undefined;
    if (chosen) return { ...selection, instanceId: chosen };
    const input = { selection, accounts, resting: this.state.resting, now: this.now() };
    const own = accounts.find((account) => account.instanceId === selection.instanceId);
    if (!own?.eligible || canTake(own, input, false)) return selection;
    return routeSelection({ config: this.options.config(), ...input });
  }

  choose(threadId: string, ranOut: string, to: string, pick: string): void {
    const away = this.state.away[threadId];
    this.state.away[threadId] = { from: away?.from ?? ranOut, at: new Date(this.now()).toISOString(), to, ranOut, pick };
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
    if (ranOut.driverKind !== own.driverKind || to.driverKind !== own.driverKind) return undefined;
    if (own.models.includes(selection.model) && !to.models.includes(selection.model)) return undefined;
    if (!this.restOf(ranOut, accounts, selection.model) || this.restOf(to, accounts, selection.model)) return undefined;
    return to.instanceId;
  }

  /** An account reported its usage limit: it rests until the reported reset,
   * else what the provider's usage reading says, else DEFAULT_REST_MS. */
  markExhausted(instanceId: string, quota: Quota = {}): Rest {
    const now = this.now();
    const reset = resetInstant(quota.resetsAt, now);
    const kind = quota.kind && /^[a-z][a-z0-9_-]{0,39}$/i.test(quota.kind) ? quota.kind.toLowerCase() : undefined;
    const rest: Rest = {
      until: reset ?? new Date(now + DEFAULT_REST_MS).toISOString(),
      ...(kind ? { kind } : {}),
      ...(reset ? {} : { estimated: true }),
      since: new Date(now).toISOString(),
    };
    this.state.resting[instanceId] = rest;
    this.save();
    // Asking the provider is the battery's business, so only while it is on.
    if (!reset && this.enabled && this.options.planReset) void this.refine(instanceId, rest);
    return rest;
  }

  private async refine(instanceId: string, rest: Rest): Promise<void> {
    try {
      const found = resetInstant(await this.options.planReset!(instanceId, rest.kind), this.now());
      // A newer report, or a turn that proved the account works, wins.
      if (!found || this.state.resting[instanceId] !== rest) return;
      const { estimated: _estimated, ...known } = rest;
      this.state.resting[instanceId] = { ...known, until: found };
      this.save();
    } catch {
      // The estimate stands.
    }
  }

  /** A turn on this account finished well: its rest is over, if that turn
   * began after the limit was reported. One already running then (another
   * conversation's) proves nothing, so without its start only an estimated
   * rest ends here; a reported one ends at its reset. */
  recovered(instanceId: string, startedAt?: number): boolean {
    const rest = this.state.resting[instanceId];
    if (!rest) return false;
    if (startedAt === undefined ? !rest.estimated : startedAt < Date.parse(rest.since)) return false;
    delete this.state.resting[instanceId];
    this.save();
    return true;
  }

  /** The account was removed. */
  forget(instanceId: string): void {
    let changed = Boolean(this.state.resting[instanceId]);
    delete this.state.resting[instanceId];
    for (const [threadId, away] of Object.entries(this.state.away)) {
      if (away.from === instanceId) delete this.state.away[threadId];
      else if (away.to === instanceId || away.ranOut === instanceId) this.state.away[threadId] = { from: away.from, at: away.at };
      else continue;
      changed = true;
    }
    if (changed) this.save();
  }

  /** The rest an account is on now, its own or its login's. */
  restOf(account: BatteryAccount, accounts: readonly BatteryAccount[], model?: string): (Rest & { sharedWith?: string }) | undefined {
    return activeRest(account, model, accounts, this.state.resting, this.now());
  }

  /** What the Settings card shows. */
  status(accounts: readonly BatteryAccount[]): BatteryStatus {
    const config = this.options.config();
    const resting: BatteryStatus["resting"] = {};
    for (const account of accounts) {
      if (!account.eligible) continue;
      const rest = this.restOf(account, accounts);
      if (rest) resting[account.instanceId] = rest;
    }
    return { enabled: config?.enabled === true, order: batteryOrder(config, accounts), resting };
  }

  /** Keep a dispatched turn so it can run once more on the next account. */
  trackTurn(threadId: string, turn: BatteryTurn): void {
    this.turns.delete(threadId);
    this.turns.set(threadId, turn);
    if (this.turns.size > MAX_TURNS) this.turns.delete(this.turns.keys().next().value!);
  }

  /** Whether the turn that just ended should run once more on the next
   * account: it ran out of usage, may run again, and an account other than
   * the one it ran on can take the conversation's selection now. */
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
    if (!turn?.rerun || turn.generation !== input.generation) return null;
    const from = input.accounts.find((account) => account.instanceId === (input.ranOn ?? turn.instanceId));
    const to = pickAccount({ config: this.options.config(), selection: input.selection, accounts: input.accounts, resting: this.state.resting, now: this.now() });
    if (!from || !to || to.instanceId === from.instanceId || to.driverKind !== from.driverKind) return null;
    return { turn, from, to, rest: this.restOf(from, input.accounts, input.selection.model) };
  }

  /** Take a kept turn for its one re-run; never returned twice. */
  takeTurn(threadId: string, generation: string | undefined): BatteryTurn | undefined {
    const turn = this.turns.get(threadId);
    if (!turn || turn.generation !== generation) return undefined;
    this.turns.delete(threadId);
    return turn;
  }

  /** This conversation moved off `from` because it ran out of usage. */
  noteSwitch(threadId: string, from: string): void {
    // The account it first left is the one to come back to.
    if (this.state.away[threadId]) return;
    this.state.away[threadId] = { from, at: new Date(this.now()).toISOString() };
    this.save();
  }

  /** True once when a conversation that moved off `instanceId` runs on it
   * again: the moment to say it is back. */
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
    if (this.options.file) {
      try {
        writeFileAtomic(this.options.file, JSON.stringify(this.state), { mode: 0o600, durable: false });
      } catch (error) {
        console.warn(`token battery: could not save ${this.options.file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.options.onChange?.();
  }
}
