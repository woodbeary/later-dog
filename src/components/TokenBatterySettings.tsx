// Settings → AI → Engines: the token battery (docs/laterdog/token-battery.md).
// The person's Claude and Codex subscription accounts, each engine's in the
// order its turns use them, favourite first, with one switch that turns the
// rotation on. The server owns which accounts belong here (config
// accountBattery.order lists every eligible one) and which are resting; this
// card only reorders and saves.
import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, Star } from "lucide-react";
import { api, useStore, type ConfigStatus, type InstanceInfo } from "@/state/store";
import { activeLocale, t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { Card, Switch } from "./SettingsPrimitives";

type Battery = NonNullable<ConfigStatus["accountBattery"]>;
type Rest = NonNullable<Battery["resting"]>[string];

/** The engines whose usage limits the server reports, as Settings lists them. `add` is the account the Add button
 * above makes: a Codex account is a ChatGPT sign-in. */
export const BATTERY_ENGINES = [
  { kind: "claudeAgent", name: "Claude", add: "Claude" },
  { kind: "codex", name: "Codex", add: "ChatGPT" },
] as const;
type Order = Record<string, string[]>;

export type AccountState = { kind: "ready" } | { kind: "resting"; until: string } | { kind: "signedOut" };

export interface BatteryRow {
  instance: InstanceInfo;
  state: AccountState;
  /** An earlier account signed in to the same login: they share one limit. */
  sameLoginAs?: string;
}

/** `order` with `id` moved one place up (-1) or down (+1). */
export function moveAccount(order: readonly string[], id: string, by: -1 | 1): string[] {
  const from = order.indexOf(id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

/** `order` with `id` first: the favourite. */
export function makeFavourite(order: readonly string[], id: string): string[] {
  return order.includes(id) ? [id, ...order.filter((other) => other !== id)] : [...order];
}

/** Ready, resting until its limit resets, or not signed in. */
export function accountState(instance: InstanceInfo, rest: Rest | undefined, now: number): AccountState {
  if (instance.snapshot.state === "unavailable" || instance.snapshot.authenticated === false) return { kind: "signedOut" };
  if (rest && Date.parse(rest.until) > now) return { kind: "resting", until: rest.until };
  return { kind: "ready" };
}

/** The rows of `order` that are accounts this server has, in that order. */
export function batteryRows(order: readonly string[], battery: Battery | undefined, instances: readonly InstanceInfo[], now: number): BatteryRow[] {
  const rows: BatteryRow[] = [];
  for (const id of order) {
    const instance = instances.find((candidate) => candidate.instanceId === id);
    if (!instance) continue;
    const email = instance.snapshot.account?.email?.trim().toLowerCase();
    const twin = email ? rows.find((row) => row.instance.snapshot.account?.email?.trim().toLowerCase() === email) : undefined;
    rows.push({
      instance,
      state: accountState(instance, battery?.resting?.[id], now),
      ...(twin ? { sameLoginAs: twin.instance.displayName } : {}),
    });
  }
  return rows;
}

/** "3:00 PM" today, "Oct 9, 5:00 PM" on another day. */
function resetTime(until: string, now: number): string {
  const at = new Date(until);
  return at.toDateString() === new Date(now).toDateString()
    ? at.toLocaleTimeString(activeLocale(), { hour: "numeric", minute: "2-digit" })
    : at.toLocaleString(activeLocale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function stateLabel(state: AccountState, now: number): string {
  if (state.kind === "signedOut") return t("settings.battery.signedOut");
  if (state.kind === "resting") return t("settings.battery.resting", { time: resetTime(state.until, now) });
  return t("settings.battery.ready");
}

export function TokenBatterySettings() {
  const { state, dispatch } = useStore();
  const [draft, setDraft] = useState<{ enabled: boolean; order: Order } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const saved = state.config?.accountBattery;
  const value = draft ?? { enabled: saved?.enabled === true, order: Object.fromEntries(BATTERY_ENGINES.map((engine) => [engine.kind, saved?.order?.[engine.kind] ?? []])) };
  const now = Date.now();
  const engines = BATTERY_ENGINES.map((engine) => ({ ...engine, rows: batteryRows(value.order[engine.kind] ?? [], saved, state.instances, now) }));
  const change = (next: { enabled: boolean; order: Order }) => { setDraft(next); setError(""); };
  /** The order with one engine's list replaced. */
  const reorder = (kind: string, ids: string[]) => change({ ...value, order: { ...value.order, [kind]: ids } });
  const save = async () => {
    if (!draft || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const config = await api<ConfigStatus>("/api/config", {
        method: "PUT",
        body: JSON.stringify({ accountBattery: { enabled: draft.enabled,
          order: Object.fromEntries(engines.map((engine) => [engine.kind, engine.rows.map((row) => row.instance.instanceId)])) } }),
      });
      dispatch({ type: "configStatus", config });
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.battery.error"));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const busy = saving || !saved;
  return (
    <Card title={t("settings.battery.title")}>
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="token-battery-enabled" className="text-[13px] font-medium text-ink">{t("settings.battery.enable")}</label>
        <Switch id="token-battery-enabled" checked={value.enabled} disabled={busy}
          aria-describedby="token-battery-help token-battery-terms"
          onClick={() => change({ ...value, enabled: !value.enabled })} />
      </div>
      <p id="token-battery-help" className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("settings.battery.help")}</p>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("settings.battery.carries")}</p>
      <div className="mt-4 text-[13px] font-medium text-ink">{t("settings.battery.order")}</div>
      {/* An engine is listed once it has an account; with none at all, one line says so. */}
      {engines.every((engine) => engine.rows.length === 0) && (
        <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("settings.battery.empty")}</p>
      )}
      {engines.filter((engine) => engine.rows.length > 0).map(({ kind, name: engineName, add, rows }) => (
        <section key={kind} className="mt-3">
          <div className="text-[12px] font-medium text-ink-secondary" id={`token-battery-order-${kind}`}>{engineName}</div>
          <ol aria-labelledby={`token-battery-order-${kind}`} className="mt-1.5 flex flex-col gap-1.5">
            {rows.map((row, index) => {
              const name = row.instance.displayName;
              const favourite = index === 0;
              const email = row.instance.snapshot.account?.email;
              const ids = rows.map((entry) => entry.instance.instanceId);
              return (
                <li key={row.instance.instanceId} className="flex min-w-0 items-center gap-2 rounded-lg border border-hairline/40 px-2.5 py-2">
                  {favourite ? (
                    <span role="img" aria-label={t("settings.battery.favourite")} title={t("settings.battery.favourite")}
                      className="flex h-7 w-7 shrink-0 items-center justify-center text-accent">
                      <Star size={14} className="fill-current" aria-hidden />
                    </span>
                  ) : (
                    <button type="button" disabled={busy} aria-label={t("settings.battery.makeFavourite", { name })} title={t("settings.battery.makeFavourite", { name })}
                      onClick={() => reorder(kind, makeFavourite(ids, row.instance.instanceId))}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-secondary enabled:hover:bg-raised/50 enabled:hover:text-ink disabled:opacity-30">
                      <Star size={14} aria-hidden />
                    </button>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-ink">{name}</div>
                    {(email || row.sameLoginAs) && (
                      <div className="truncate text-[11.5px] text-ink-secondary">
                        {[email, row.sameLoginAs && t("settings.battery.sameLogin", { name: row.sameLoginAs })].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </div>
                  <span className={cn("shrink-0 text-[11.5px]",
                    row.state.kind === "ready" ? "text-success" : row.state.kind === "resting" ? "text-warning" : "text-ink-secondary")}>
                    {stateLabel(row.state, now)}
                  </span>
                  <div className="flex shrink-0 items-center">
                    <button type="button" disabled={busy || index === 0} aria-label={t("settings.battery.moveUp", { name })}
                      onClick={() => reorder(kind, moveAccount(ids, row.instance.instanceId, -1))}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary enabled:hover:bg-raised/50 enabled:hover:text-ink disabled:opacity-30">
                      <ArrowUp size={13} aria-hidden />
                    </button>
                    <button type="button" disabled={busy || index === rows.length - 1} aria-label={t("settings.battery.moveDown", { name })}
                      onClick={() => reorder(kind, moveAccount(ids, row.instance.instanceId, 1))}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary enabled:hover:bg-raised/50 enabled:hover:text-ink disabled:opacity-30">
                      <ArrowDown size={13} aria-hidden />
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
          {rows.length === 1 && <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">{t("settings.battery.single", { account: add })}</p>}
        </section>
      ))}
      <p id="token-battery-terms" className="mt-3 text-[12px] leading-relaxed text-ink-secondary">{t("settings.battery.terms")}</p>
      <button type="button" disabled={!draft || saving} onClick={() => void save()}
        className="mt-3 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50">{saving ? t("settings.threads.saving") : t("common.save")}</button>
      {saving && <span role="status" className="sr-only">{t("settings.threads.saving")}</span>}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}
