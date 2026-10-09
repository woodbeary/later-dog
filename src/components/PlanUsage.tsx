import { useEffect, useState, useSyncExternalStore } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api } from "@/state/store";
import { activeLocale, t } from "@/lib/i18n";
import { cn } from "@/lib/cn";

export interface PlanWindow {
  available: boolean;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
}

export interface PlanExtra {
  label: string;
  remainingPercent: number;
  usedPercent: number;
  resetsAt: string | null;
}

export interface PlanModelUsage {
  name: string;
  windows: PlanExtra[];
}

export interface PlanProvider {
  id: string;
  name: string;
  driver: string;
  plan: string | null;
  ok: boolean;
  error: string | null;
  fiveHour: PlanWindow;
  weekly: PlanWindow;
  extra: PlanExtra[];
  models?: PlanModelUsage[];
}

export interface PlanUsageReport {
  fetchedAt: string;
  providers: PlanProvider[];
}

export function resetDistance(resetsAt: string | null | undefined, now: number): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at) || at <= now) return null;
  const minutes = Math.floor((at - now) / 60_000);
  if (minutes < 1) return t("planUsage.lessThanMinute");
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? t("planUsage.daysHours", { days, hours }) : t("planUsage.days", { days });
  if (hours > 0) return mins > 0 ? t("planUsage.hoursMinutes", { hours, minutes: mins }) : t("planUsage.hours", { hours });
  return t("planUsage.minutes", { minutes: mins });
}

export function resetClock(until: string, now: number): string {
  const at = new Date(until);
  return at.toDateString() === new Date(now).toDateString()
    ? at.toLocaleTimeString(activeLocale(), { hour: "numeric", minute: "2-digit" })
    : at.toLocaleString(activeLocale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function dueResetDeadlines(report: PlanUsageReport, now: number, seen: Set<string>): string[] {
  const due: string[] = [];
  for (const provider of report.providers) {
    if (!provider.ok) continue;
    const stamps = [
      provider.fiveHour.available ? provider.fiveHour.resetsAt : null,
      provider.weekly.available ? provider.weekly.resetsAt : null,
    ];
    for (const resetsAt of stamps) {
      if (!resetsAt || seen.has(resetsAt) || due.includes(resetsAt)) continue;
      const at = Date.parse(resetsAt);
      if (Number.isFinite(at) && at <= now) due.push(resetsAt);
    }
  }
  return due;
}

export const PLAN_USAGE_POLL_MS = 120_000;
const PLAN_USAGE_AFTER_TURN_MS = 30_000;
const LAST_GOOD_MS = 10 * 60_000;

interface PlanUsageSnapshot {
  report: PlanUsageReport | null;
  loading: boolean;
  error: string;
  fetchedAt: number;
}

let planUsage: PlanUsageSnapshot = { report: null, loading: false, error: "", fetchedAt: 0 };
const planUsageListeners = new Set<() => void>();
const lastGood = new Map<string, { provider: PlanProvider; at: number }>();
const refreshedDeadlines = new Set<string>();
let planUsageRequest: Promise<void> | null = null;
let pollers = 0;
let pollTimer: number | undefined;

function setPlanUsage(next: Partial<PlanUsageSnapshot>) {
  planUsage = { ...planUsage, ...next };
  for (const listener of planUsageListeners) listener();
}

export function keepLastGood(report: PlanUsageReport, previous: ReadonlyMap<string, { provider: PlanProvider; at: number }>, now: number): PlanUsageReport {
  return {
    ...report,
    providers: report.providers.map((provider) => {
      const kept = previous.get(provider.id);
      return !provider.ok && kept && now - kept.at < LAST_GOOD_MS ? kept.provider : provider;
    }),
  };
}

export function reloadPlanUsage(refresh = false): Promise<void> {
  if (planUsageRequest && !refresh) return planUsageRequest;
  setPlanUsage({ loading: true });
  const request = api<PlanUsageReport>(refresh ? "/api/plan-usage?refresh=1" : "/api/plan-usage")
    .then((report) => {
      const now = Date.now();
      const merged = keepLastGood(report, lastGood, now);
      for (const provider of report.providers) if (provider.ok) lastGood.set(provider.id, { provider, at: now });
      setPlanUsage({ report: merged, error: "", fetchedAt: now });
    }, (cause: unknown) => {
      setPlanUsage({ error: cause instanceof Error && cause.message ? cause.message : t("planUsage.fetchError") });
    })
    .finally(() => {
      if (planUsageRequest !== request) return;
      planUsageRequest = null;
      setPlanUsage({ loading: false });
    });
  planUsageRequest = request;
  return request;
}

export function refreshPlanUsageAfterTurn(): void {
  if (pollers > 0 && Date.now() - planUsage.fetchedAt >= PLAN_USAGE_AFTER_TURN_MS) void reloadPlanUsage();
}

function pollPlanUsage() {
  if (document.visibilityState === "hidden") return;
  const now = Date.now();
  const due = planUsage.report ? dueResetDeadlines(planUsage.report, now, refreshedDeadlines) : [];
  if (due.length > 0) {
    for (const deadline of due) refreshedDeadlines.add(deadline);
    void reloadPlanUsage(true);
  } else if (now - planUsage.fetchedAt >= PLAN_USAGE_POLL_MS) {
    void reloadPlanUsage();
  }
}

function listen(listener: () => void) {
  planUsageListeners.add(listener);
  return () => {
    planUsageListeners.delete(listener);
  };
}

function listenAndPoll(listener: () => void) {
  const stop = listen(listener);
  pollers += 1;
  if (pollers === 1) {
    pollTimer = window.setInterval(pollPlanUsage, 30_000);
    document.addEventListener("visibilitychange", pollPlanUsage);
  }
  pollPlanUsage();
  return () => {
    stop();
    pollers -= 1;
    if (pollers > 0) return;
    window.clearInterval(pollTimer);
    document.removeEventListener("visibilitychange", pollPlanUsage);
  };
}

const readPlanUsage = () => planUsage;

export function usePlanUsage({ enabled = true }: { enabled?: boolean } = {}) {
  const snapshot = useSyncExternalStore(enabled ? listenAndPoll : listen, readPlanUsage, readPlanUsage);
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return {
    report: snapshot.report,
    loading: snapshot.loading || (enabled && snapshot.fetchedAt === 0 && !snapshot.error),
    error: snapshot.error,
    now: Math.max(tick, snapshot.fetchedAt),
    reload: reloadPlanUsage,
  };
}

export function UsageBar({ used, label }: { used: number; label: string }) {
  const clamped = Math.round(Math.min(100, Math.max(0, used)));
  return (
    <div
      className="h-1 w-full overflow-hidden rounded-full bg-control"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
    >
      <div className={cn("h-full rounded-full", clamped >= 90 ? "bg-danger" : "bg-accent")} style={{ width: `${clamped}%` }} />
    </div>
  );
}

function windowLine(label: string, window: PlanWindow, now: number): string | null {
  if (!window.available || window.usedPercent == null) return null;
  const when = resetDistance(window.resetsAt, now);
  return [label, t("planUsage.used", { used: Math.round(window.usedPercent) }), when ? t("planUsage.resetsIn", { when }) : null].filter(Boolean).join(" · ");
}

export function AccountUsage({ provider, now, loading = false, resting }: {
  provider: PlanProvider | undefined;
  now: number;
  loading?: boolean;
  resting?: { until: string } | undefined;
}) {
  const quiet = "text-[12px] text-ink-secondary";
  if (resting && Date.parse(resting.until) > now) {
    return <p className={cn(quiet, "text-warning")}>{t("accounts.resting", { time: resetClock(resting.until, now) })}</p>;
  }
  if (!provider) return <p className={quiet}>{loading ? t("planUsage.loading") : t("planUsage.none")}</p>;
  if (!provider.ok) return <p className={quiet}>{provider.error || t("planUsage.none")}</p>;
  const session = windowLine(t("planUsage.fiveHour"), provider.fiveHour, now);
  const weekly = windowLine(t("planUsage.weekly"), provider.weekly, now);
  if (!session && !weekly) return <p className={quiet}>{t("planUsage.none")}</p>;
  return (
    <div className="flex flex-col gap-1">
      {session && provider.fiveHour.usedPercent != null && (
        <>
          <UsageBar used={provider.fiveHour.usedPercent} label={t("planUsage.fiveHour")} />
          <p className={cn(quiet, "tabular-nums")}>{session}</p>
        </>
      )}
      {weekly && <p className={cn(quiet, "tabular-nums")}>{weekly}</p>}
    </div>
  );
}

export function PlanUsage() {
  const { report, loading, error, now, reload } = usePlanUsage();
  return (
    <section data-plan-usage="" className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between pl-4">
        <h3 className="text-[12px] font-medium text-ink-secondary">{t("accounts.title")}</h3>
        <button
          type="button"
          onClick={() => void reload(true)}
          disabled={loading}
          aria-label={t("planUsage.refresh")}
          title={t("planUsage.refresh")}
          className="rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-45"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
      </div>
      <div className="rounded-xl bg-card">
        {error && <p role="alert" className="px-4 py-3 text-[13px] text-danger">{error}</p>}
        {!error && loading && !report && <p role="status" className="px-4 py-3 text-[13px] text-ink-secondary">{t("planUsage.loading")}</p>}
        {!error && report && report.providers.length === 0 && <p className="px-4 py-3 text-[13px] text-ink-secondary">{t("planUsage.empty")}</p>}
        {report && report.providers.map((provider, index) => (
          <div key={provider.id} className={cn("flex flex-col gap-2 px-4 py-3", index > 0 && "border-t border-hairline/40")}>
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-[13px] font-medium text-ink">{provider.name}</span>
              {provider.plan && <span className="truncate text-[12px] text-ink-secondary">{provider.plan}</span>}
            </div>
            <AccountUsage provider={provider} now={now} />
          </div>
        ))}
      </div>
    </section>
  );
}
