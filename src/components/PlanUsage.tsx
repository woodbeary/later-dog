import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { resetDistance } from "@/lib/reset-time";
import { RestCharge, usageLeft, type AccountRest } from "./AccountCharge";

export { resetClock, resetDistance } from "@/lib/reset-time";

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

export function useRefreshAfterTurn(busy: boolean | undefined): void {
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) refreshPlanUsageAfterTurn();
    wasBusy.current = busy;
  }, [busy]);
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

export type UsageTone = "accent" | "warning" | "danger";

export function usageTone(used: number): UsageTone {
  return used >= 90 ? "danger" : used >= 75 ? "warning" : "accent";
}

const BAR_TONE: Record<UsageTone, string> = { accent: "bg-accent", warning: "bg-warning", danger: "bg-danger" };

export function UsageBar({ used, label, className }: { used: number; label: string; className?: string }) {
  const left = usageLeft(used);
  return (
    <span
      className={cn("block h-1 w-full overflow-hidden rounded-full bg-control", className)}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={left}
      aria-valuetext={t("planUsage.left", { left })}
    >
      <span className={cn("block h-full rounded-full", BAR_TONE[usageTone(100 - left)])} style={{ width: `${left}%` }} />
    </span>
  );
}

function windowLine(label: string, window: PlanWindow, now: number): string | null {
  if (!window.available || window.usedPercent == null) return null;
  const when = resetDistance(window.resetsAt, now);
  return [label, t("planUsage.left", { left: usageLeft(window.usedPercent) }), when ? t("planUsage.resetsIn", { when }) : null].filter(Boolean).join(" · ");
}

export interface UsageReading {
  used: number;
  label: string;
  resetsAt: string | null;
}

export function usageReading(provider: PlanProvider | undefined): UsageReading | null {
  if (!provider?.ok) return null;
  let reading: UsageReading | null = null;
  for (const [label, window] of [[t("planUsage.fiveHour"), provider.fiveHour], [t("planUsage.weekly"), provider.weekly]] as const) {
    if (!window.available || window.usedPercent == null) continue;
    if (!reading || window.usedPercent > reading.used) reading = { used: window.usedPercent, label, resetsAt: window.resetsAt };
  }
  return reading;
}

export function usageLines(provider: PlanProvider | undefined, now: number): string[] {
  if (!provider?.ok) return [];
  return [windowLine(t("planUsage.fiveHour"), provider.fiveHour, now), windowLine(t("planUsage.weekly"), provider.weekly, now)]
    .filter((line): line is string => line !== null);
}

export function AccountUsage({ provider, now, loading = false, resting }: {
  provider: PlanProvider | undefined;
  now: number;
  loading?: boolean;
  resting?: AccountRest | undefined;
}) {
  const quiet = "text-[12px] text-ink-secondary";
  if (resting && Date.parse(resting.until) > now) return <RestCharge rest={resting} now={now} />;
  if (!provider) return loading ? <p className={quiet}>{t("planUsage.loading")}</p> : null;
  if (!provider.ok) return null;
  const windows = ([[t("planUsage.fiveHour"), provider.fiveHour], [t("planUsage.weekly"), provider.weekly]] as const).flatMap(([label, window]) => {
    const line = windowLine(label, window, now);
    return line && window.usedPercent != null ? [{ label, line, used: window.usedPercent }] : [];
  });
  if (windows.length === 0) return null;
  return (
    <div className="flex flex-col gap-2.5">
      {windows.map((window) => (
        <div key={window.label} className="flex flex-col gap-1">
          <UsageBar used={window.used} label={window.label} className="h-1.5" />
          <p className={cn(quiet, "tabular-nums")}>{window.line}</p>
        </div>
      ))}
    </div>
  );
}
