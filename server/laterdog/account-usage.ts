import type { PlanProviderRow, PlanWindow } from "../plan-usage.ts";
import { engineName, percentLeft, type BatteryAccount, type Rest } from "./account-battery.ts";
import { accountLabel } from "./account-switch.ts";

export const ACCOUNT_USAGE_PATH = "/api/internal/account-usage";

export interface AccountUsageInput {
  account: BatteryAccount;
  row: PlanProviderRow | undefined;
  rest: Rest | undefined;
  env?: { name: string; value: string };
}

export interface AccountUsageWindow {
  usedPercent: number;
  resetsAt: string | null;
}

export interface AccountUsageRow {
  id: string;
  name: string;
  engine: string;
  email?: string;
  status: "ready" | "resting" | "off" | "signed out";
  leftPercent?: number;
  fiveHour?: AccountUsageWindow;
  weekly?: AccountUsageWindow;
  restingUntil?: string;
  env?: { name: string; value: string };
  current: boolean;
}

export interface AccountUsageReport {
  accounts: AccountUsageRow[];
  roomiest?: string;
  current?: string;
}

function shown(window: PlanWindow | undefined, now: number): AccountUsageWindow | undefined {
  if (!window?.available || window.usedPercent === null) return undefined;
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return { usedPercent: reset <= now ? 0 : Math.round(window.usedPercent), resetsAt: reset <= now ? null : window.resetsAt };
}

export function accountUsage(inputs: readonly AccountUsageInput[], current: string | undefined, now: number): AccountUsageReport {
  const accounts = inputs.map(({ account, row, rest, env }): AccountUsageRow => {
    const status = !account.enabled ? "off" : account.signedIn === false ? "signed out" : rest ? "resting" : "ready";
    const left = percentLeft(row, now);
    const fiveHour = shown(row?.fiveHour, now);
    const weekly = shown(row?.weekly, now);
    return {
      id: account.instanceId,
      name: accountLabel(account),
      engine: engineName(account.driverKind),
      ...(account.email ? { email: account.email } : {}),
      status,
      ...(left === undefined ? {} : { leftPercent: Math.round(left) }),
      ...(fiveHour ? { fiveHour } : {}),
      ...(weekly ? { weekly } : {}),
      ...(rest ? { restingUntil: rest.until } : {}),
      ...(env ? { env } : {}),
      current: account.instanceId === current,
    };
  });
  accounts.sort((a, b) => Number(a.status !== "ready") - Number(b.status !== "ready") ||
    Number(a.leftPercent === undefined) - Number(b.leftPercent === undefined) || (b.leftPercent ?? 0) - (a.leftPercent ?? 0));
  const roomiest = accounts.find((row) => row.status === "ready");
  return { accounts, ...(roomiest ? { roomiest: roomiest.id } : {}), ...(current ? { current } : {}) };
}

function when(iso: string | null | undefined, now: number, timeZone?: string): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const sameDay = at - now < 20 * 3600 * 1000;
  return new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "numeric", minute: "2-digit",
  }).format(new Date(at));
}

function windowWords(label: string, window: AccountUsageWindow | undefined, now: number, timeZone?: string): string {
  if (!window) return `${label} unknown`;
  const reset = when(window.resetsAt, now, timeZone);
  return `${label} ${window.usedPercent}% used${reset ? `, resets ${reset}` : ""}`;
}

export function accountUsageText(report: AccountUsageReport, now: number, timeZone?: string): string {
  if (!report.accounts.length) return "No plan accounts here: this home runs on API keys or hosted models only.";
  const lines = report.accounts.map((row) => {
    const who = row.email ? `${row.name} (${row.email})` : row.name;
    const state = row.status === "resting"
      ? `resting until ${when(row.restingUntil, now, timeZone)}`
      : row.status === "ready" ? `${row.leftPercent === undefined ? "room unknown" : `${row.leftPercent}% left`}` : row.status;
    const marks = [row.current ? "this chat" : "", row.id === report.roomiest ? "most room" : ""].filter(Boolean).join(", ");
    return `- ${who} [id: ${row.id}, ${row.engine}${marks ? `, ${marks}` : ""}]: ${state}. ${windowWords("5-hour", row.fiveHour, now, timeZone)}; ${windowWords("7-day", row.weekly, now, timeZone)}.`;
  });
  const best = report.accounts.find((row) => row.id === report.roomiest);
  const run = best?.env
    ? `\n\nTo run your own ${best.engine} command-line work on the account with the most room, start it with ${best.env.name}=${best.env.value}` +
      (best.engine === "Claude" ? " and without ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN set (env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN …)." : ".")
    : best ? "" : "\n\nEvery account is resting or off right now.";
  return `Plan accounts, by how much is left:\n${lines.join("\n")}${run}\n\nYour own turns move to an account with room by themselves when this one runs low. To move this chat onto one by name, use switch_account.`;
}

export const USAGE_HANDLED_LINE = " Usage limits are handled automatically: when an account runs out, the turn continues on another. Never stop, defer, shrink or ask about work because of usage.";

export function accountTurnPrompt(input: AccountUsageInput | undefined, now: number, timeZone?: string, managesAccounts = false): string {
  if (!managesAccounts || !input) return USAGE_HANDLED_LINE;
  const [row] = accountUsage([input], input.account.instanceId, now).accounts;
  if (!row) return USAGE_HANDLED_LINE;
  const who = row.email ? `${row.name} (${row.email})` : row.name;
  const state = row.status === "resting" ? `, resting until ${when(row.restingUntil, now, timeZone)}` : row.status === "ready" ? "" : `, ${row.status}`;
  const left = (window: AccountUsageWindow | undefined) => (window ? `${100 - window.usedPercent}% left` : "unknown");
  return USAGE_HANDLED_LINE + ` This turn runs on the ${row.engine} plan account ${who}${state}: session (5-hour) ${left(row.fiveHour)}, weekly ${left(row.weekly)}.` +
    " account_usage shows every account; switch_account moves this chat to another.";
}

export interface DogAccountInput {
  id: string;
  name: string;
  main: boolean;
  pinned: boolean;
  account: string;
  runsOn?: string;
  busy: boolean;
}

export function dogAccountsText(dogs: readonly DogAccountInput[], report: AccountUsageReport, now: number, timeZone?: string): string {
  const byId = new Map(report.accounts.map((row) => [row.id, row]));
  const label = (id: string) => byId.get(id)?.name ?? id;
  const accounts = report.accounts.map((row) => {
    const state = row.status === "resting" ? `resting until ${when(row.restingUntil, now, timeZone)}` : row.status;
    const count = dogs.filter((dog) => (dog.runsOn ?? dog.account) === row.id).length;
    return `- ${row.name} [id: ${row.id}, ${row.engine}]: ${state}; ${windowWords("5-hour", row.fiveHour, now, timeZone)}; ${windowWords("7-day", row.weekly, now, timeZone)}; ${count} dog${count === 1 ? "" : "s"} on it.`;
  });
  const rows = dogs.map((dog) => {
    const runs = dog.runsOn && dog.runsOn !== dog.account ? `, running on ${label(dog.runsOn)} for now` : "";
    const marks = [dog.main ? "main dog" : "", dog.pinned ? "pinned" : "", dog.busy ? "working" : ""].filter(Boolean).join(", ");
    return `- ${dog.name} [id: ${dog.id}${marks ? `, ${marks}` : ""}]: ${label(dog.account)}${runs}`;
  });
  return `Accounts:\n${accounts.join("\n")}\n\nDogs:\n${rows.join("\n")}\n\nTo put dogs on an account, call dog_accounts with dogs and account. Assigned dogs are pinned: they and the helpers they start stay on that account and move only when it runs out.`;
}
