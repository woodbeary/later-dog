import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { formatMoney } from "@/lib/included-usage";
import { formatTokens, formatUsd, hasFiniteCost, headlineTokens, tokensColumnLabel } from "@/lib/usage";
import { BarList, ChartEmpty, ColumnChart, ViewToggle, type ChartView } from "./UsageCharts";

export type UsageGroupBy = "bot" | "model" | "day";
export const USAGE_GROUPINGS: readonly UsageGroupBy[] = ["bot", "model", "day"];
export type UsagePeriod = "month" | "lastMonth" | "days30";

export interface UsageGroup {
  key: string;
  label: string;
  turns: number;
  input: number;
  output: number;
  cachedInput: number;
  costUsd: number | null;
  estimatedUsd?: number | null;
  unpriced: number;
}

export interface UsageSummary {
  from: string;
  to: string;
  groupBy: UsageGroupBy;
  groups: UsageGroup[];
  total: UsageGroup;
}

export function usagePeriodRange(period: UsagePeriod | "year", now = new Date()): { from: string; to: string } {
  const day = (date: Date) => date.toISOString().slice(0, 10);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (period === "month") return { from: day(new Date(Date.UTC(year, month, 1))), to: day(now) };
  if (period === "year") return { from: day(new Date(now.getTime() - 365 * 24 * 60 * 60_000)), to: day(now) };
  if (period === "lastMonth") return { from: day(new Date(Date.UTC(year, month - 1, 1))), to: day(new Date(Date.UTC(year, month, 0))) };
  return { from: day(new Date(now.getTime() - 29 * 24 * 60 * 60_000)), to: day(now) };
}

export function usageExportHref(range: { from: string; to: string }): string {
  return `/api/usage.csv?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
}

export function periodDays(range: { from: string; to: string }): string[] {
  const days: string[] = [];
  const end = Date.parse(`${range.to}T00:00:00Z`);
  for (let at = Date.parse(`${range.from}T00:00:00Z`); at <= end && days.length < 400; at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

const GROUP_LABEL_KEYS: Record<UsageGroupBy, "usage.history.byBot" | "usage.history.byModel" | "usage.history.byDay"> = {
  bot: "usage.history.byBot",
  model: "usage.history.byModel",
  day: "usage.history.byDay",
};

function estimatedPart(group: UsageGroup): boolean {
  return hasFiniteCost(group.estimatedUsd) && group.estimatedUsd > 0;
}

function costText(group: UsageGroup): string {
  if (!hasFiniteCost(group.costUsd)) return "—";
  return `${estimatedPart(group) ? "~" : ""}${formatMoney(group.costUsd)}${group.unpriced > 0 ? "*" : ""}`;
}

function CostCell({ group, strong = false }: { group: UsageGroup; strong?: boolean }) {
  if (!hasFiniteCost(group.costUsd)) return <span className={cn("text-right tabular-nums", strong ? "" : "text-ink-secondary")}>—</span>;
  const estimated = estimatedPart(group);
  return (
    <span className={cn("text-right tabular-nums", strong ? "" : "text-ink")} title={estimated ? t("usage.history.estimatedPart", { amount: formatUsd(group.estimatedUsd!) }) : undefined}>
      {estimated && <span className="text-ink-secondary">~</span>}
      {formatUsd(group.costUsd)}
      {group.unpriced > 0 && <span className="text-ink-secondary">*</span>}
    </span>
  );
}

function HistoryNotes({ total }: { total: UsageGroup }) {
  return (
    <>
      {estimatedPart(total) && (
        <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">{t("usage.history.estimated", { amount: formatUsd(total.estimatedUsd!) })}</div>
      )}
      {total.unpriced > 0 && (
        <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">{t("usage.history.unpriced", { count: String(total.unpriced) })}</div>
      )}
    </>
  );
}

export function UsageHistoryTable({ summary }: { summary: UsageSummary }) {
  if (summary.groups.length === 0) {
    return <div className="text-[13px] text-ink-secondary">{t("usage.history.empty")}</div>;
  }
  const columns = "grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-5";
  return (
    <div className="flex flex-col">
      <div className={cn(columns, "border-b border-hairline/40 pb-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary")}>
        <span>{t(GROUP_LABEL_KEYS[summary.groupBy])}</span>
        <span className="text-right">{t("usage.colTurns")}</span>
        <span className="text-right">{tokensColumnLabel(summary.total)}</span>
        <span className="text-right">{t("usage.colCost")}</span>
      </div>
      {summary.groups.map((group) => (
        <div key={group.key} className={cn(columns, "border-b border-hairline/20 py-2 text-[13px]")}>
          <span className="truncate text-ink" title={group.label}>{group.label}</span>
          <span className="text-right tabular-nums text-ink-secondary">{group.turns}</span>
          <span className="text-right tabular-nums text-ink" title={t("usage.history.tokenSplit", { input: formatTokens(group.input), output: formatTokens(group.output), cached: formatTokens(group.cachedInput) })}>
            {formatTokens(headlineTokens(group))}
          </span>
          <CostCell group={group} />
        </div>
      ))}
      <div className={cn(columns, "pt-2.5 text-[13px] font-medium text-ink")}>
        <span>{t("usage.history.total")}</span>
        <span className="text-right tabular-nums">{summary.total.turns}</span>
        <span className="text-right tabular-nums">{formatTokens(headlineTokens(summary.total))}</span>
        <CostCell group={summary.total} strong />
      </div>
      <HistoryNotes total={summary.total} />
    </div>
  );
}

function HistoryTotals({ total }: { total: UsageGroup }) {
  const stats = [
    { key: "turns", label: t("usage.colTurns"), value: String(total.turns) },
    { key: "tokens", label: tokensColumnLabel(total), value: formatTokens(headlineTokens(total)) },
    { key: "cost", label: t("usage.colCost"), value: costText(total) },
  ];
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-2">
      {stats.map((stat) => (
        <div key={stat.key} className="flex flex-col">
          <dt className="text-[12px] text-ink-secondary">{stat.label}</dt>
          <dd className="text-[15px] font-medium tabular-nums text-ink">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function GroupTip({ group, total }: { group: UsageGroup; total: UsageGroup }) {
  const lines = [
    [t("usage.colTurns"), String(group.turns)],
    [tokensColumnLabel(total), formatTokens(headlineTokens(group))],
    [t("usage.colCost"), costText(group)],
  ];
  return (
    <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
      {lines.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-ink-secondary">{label}</dt>
          <dd className="text-right tabular-nums text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function HistoryChart({ summary, range }: { summary: UsageSummary; range: { from: string; to: string } }) {
  if (summary.groups.length === 0) return <ChartEmpty>{t("usage.history.empty")}</ChartEmpty>;
  const priced = hasFiniteCost(summary.total.costUsd);
  const measure = (group: UsageGroup): number | null => (priced ? group.costUsd : headlineTokens(group));
  const format = priced ? formatMoney : (value: number) => formatTokens(Math.round(value));
  const label = `${t("usage.history.title")} · ${priced ? t("usage.colCost") : tokensColumnLabel(summary.total)}`;
  const byDay = new Map(summary.groups.map((group) => [group.label, measure(group) ?? 0]));
  const days = summary.groupBy === "day" ? periodDays(range) : [];
  return (
    <div>
      <div className="flex flex-col gap-4">
        <HistoryTotals total={summary.total} />
        {summary.groupBy === "day" ? (
          <ColumnChart
            days={days}
            series={[{ key: "history", label, color: 1, values: days.map((day) => byDay.get(day) ?? 0) }]}
            scale={priced ? "money" : "count"}
            format={format}
            label={label}
            today={new Date().toISOString().slice(0, 10)}
          />
        ) : (
          <BarList
            label={label}
            format={format}
            rows={summary.groups.map((group) => {
              const value = measure(group);
              return {
                key: group.key,
                label: group.label,
                value,
                valueLabel: value === null ? "—" : priced ? costText(group) : format(value),
                tip: <GroupTip group={group} total={summary.total} />,
              };
            })}
          />
        )}
      </div>
      <HistoryNotes total={summary.total} />
    </div>
  );
}

export async function fetchUsage(range: { from: string; to: string }, groupBy: UsageGroupBy): Promise<UsageSummary> {
  return api(`/api/usage?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&groupBy=${groupBy}`);
}

export function UsageHistory({ load = fetchUsage }: { load?: typeof fetchUsage }) {
  const [period, setPeriod] = useState<UsagePeriod>("month");
  const [groupBy, setGroupBy] = useState<UsageGroupBy>("bot");
  const [view, setView] = useState<ChartView>("chart");
  const [loaded, setLoaded] = useState<{ summary: UsageSummary; range: { from: string; to: string } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const range = usagePeriodRange(period);

  useEffect(() => {
    let current = true;
    const asked = usagePeriodRange(period);
    setLoading(true);
    setError(null);
    load(asked, groupBy)
      .then((summary) => { if (current) setLoaded({ summary, range: asked }); })
      .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [period, groupBy, load]);

  return (
    <section data-usage-history="" className="flex flex-col gap-1.5">
      <h3 className="px-4 text-[12px] font-medium text-ink-secondary">{t("usage.history.title")}</h3>
      <div className="rounded-xl bg-card px-4 py-3">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select
            value={period}
            onChange={(event) => setPeriod(event.target.value as UsagePeriod)}
            aria-label={t("usage.history.period")}
            className="rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-[12.5px] text-ink focus:outline-none"
          >
            <option value="month">{t("usage.history.thisMonth")}</option>
            <option value="lastMonth">{t("usage.history.lastMonth")}</option>
            <option value="days30">{t("usage.history.last30Days")}</option>
          </select>
          <div role="tablist" aria-label={t("usage.history.groupBy")} className="flex flex-wrap gap-1">
            {USAGE_GROUPINGS.map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={groupBy === option}
                onClick={() => setGroupBy(option)}
                className={cn(
                  "rounded-lg px-2.5 py-1 text-[12px]",
                  groupBy === option ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
                )}
              >
                {t(GROUP_LABEL_KEYS[option])}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <ViewToggle view={view} onChange={setView} />
            <a
              href={usageExportHref(range)}
              download
              className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12px] text-ink-secondary hover:bg-raised/50 hover:text-ink"
            >
              <Download size={13} />{t("usage.history.export")}
            </a>
          </div>
        </div>
        {error && <p role="alert" className="mb-2 text-[12px] text-danger">{error}</p>}
        {loading && !loaded ? (
          <div className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{t("common.checking")}</div>
        ) : loaded ? (
          <div aria-busy={loading} className={cn("transition-opacity motion-reduce:transition-none", loading && "opacity-60")}>
            {view === "chart" ? <HistoryChart summary={loaded.summary} range={loaded.range} /> : <UsageHistoryTable summary={loaded.summary} />}
          </div>
        ) : null}
      </div>
    </section>
  );
}
