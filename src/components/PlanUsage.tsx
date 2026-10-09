import { useCallback, useEffect, useRef, useState } from "react";
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

export function usePlanUsage() {
  const [report, setReport] = useState<PlanUsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const refreshedDeadlines = useRef(new Set<string>());

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError("");
    try {
      const data = await api<PlanUsageReport>(refresh ? "/api/plan-usage?refresh=1" : "/api/plan-usage");
      setReport(data);
      setNow(Date.now());
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("planUsage.fetchError"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!report) return;
    const due = dueResetDeadlines(report, now, refreshedDeadlines.current);
    if (due.length === 0) return;
    for (const deadline of due) refreshedDeadlines.current.add(deadline);
    void load(true);
  }, [report, now, load]);

  return { report, loading, error, now, reload: load };
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
