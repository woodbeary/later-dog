import { useEffect, useState } from "react";

import { t } from "@/lib/i18n";
import { formatCount, formatDay, formatDuration } from "@/lib/included-usage";
import { api, type Bot } from "@/state/store";
import { ChartEmpty, ColumnChart, DataTable, MetricTiles, ViewToggle, type ChartView } from "../UsageCharts";

export const ACTIVITY_SHOWN_DAYS = 14;

export interface DayActivity {
  day: string;
  sent: number;
  replies: number;
  turns: number;
  workedSeconds: number;
}

export interface DogActivityView {
  today: string;
  days: DayActivity[];
  totals: Omit<DayActivity, "day">;
}

export type ActivityMetric = "workedSeconds" | "sent" | "replies" | "turns";

const METRICS: ReadonlyArray<{ key: ActivityMetric; label: "activity.worked" | "activity.sent" | "activity.replies" | "activity.turns" }> = [
  { key: "workedSeconds", label: "activity.worked" },
  { key: "sent", label: "activity.sent" },
  { key: "replies", label: "activity.replies" },
  { key: "turns", label: "activity.turns" },
];

export function formatActivity(metric: ActivityMetric, value: number): string {
  return metric === "workedSeconds" ? formatDuration(value) : formatCount(value);
}

export function DogActivity({ bot }: { bot: Pick<Bot, "id" | "name"> }) {
  const [activity, setActivity] = useState<DogActivityView | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<ActivityMetric>("workedSeconds");
  const [view, setView] = useState<ChartView>("chart");

  useEffect(() => {
    let active = true;
    api<DogActivityView>(`/api/bots/${encodeURIComponent(bot.id)}/activity?days=${ACTIVITY_SHOWN_DAYS}`, { timeoutMs: 15_000 })
      .then((next) => { if (active) { setActivity(next); setFailed(false); } })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [bot.id]);

  const title = t("activity.title");
  if (!activity) {
    return failed ? (
      <section data-dog-activity="" className="flex flex-col gap-1.5">
        <span className="mb-1.5 block px-1 text-[12px] font-medium text-ink-secondary">{title}</span>
        <p className="rounded-xl bg-card px-4 py-3 text-[13px] text-ink-secondary">{t("activity.loadFailed")}</p>
      </section>
    ) : null;
  }

  const metric = METRICS.find((entry) => entry.key === selected) ?? METRICS[0]!;
  const days = activity.days.map((entry) => entry.day);
  const values = activity.days.map((entry) => entry[metric.key]);
  const format = (value: number) => formatActivity(metric.key, value);
  const chartLabel = t("activity.last", { days: ACTIVITY_SHOWN_DAYS });
  const dayName = (day: string) => (day === activity.today ? t("usage.chart.today") : formatDay(day));

  return (
    <section data-dog-activity="" className="flex flex-col gap-1.5">
      <span className="mb-1.5 block px-1 text-[12px] font-medium text-ink-secondary">{title}</span>
      <div className="flex flex-col gap-4 rounded-xl bg-card px-4 py-3">
        <MetricTiles
          label={chartLabel}
          selected={metric.key}
          onSelect={(key) => setSelected(key as ActivityMetric)}
          metrics={METRICS.map((entry) => ({ key: entry.key, label: t(entry.label), value: formatActivity(entry.key, activity.totals[entry.key]) }))}
        />
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] text-ink-secondary">{chartLabel}</p>
            <ViewToggle view={view} onChange={setView} />
          </div>
          {values.every((value) => value <= 0)
            ? <ChartEmpty>{t("activity.empty")}</ChartEmpty>
            : view === "chart"
              ? <ColumnChart days={days} series={[{ key: metric.key, label: t(metric.label), color: 1, values }]} scale={metric.key === "workedSeconds" ? "duration" : "count"} format={format} label={chartLabel} today={activity.today} />
              : (
                <DataTable
                  label={chartLabel}
                  columns={[{ key: "day", label: t("usage.history.byDay") }, { key: "value", label: t(metric.label), align: "right" }]}
                  rows={days.flatMap((day, index) => (values[index]! > 0 ? [{ key: day, cells: [dayName(day), format(values[index]!)] }] : [])).reverse()}
                />
              )}
        </div>
        <p className="text-[12px] leading-relaxed text-ink-secondary">{t("activity.workedHint", { name: bot.name })}</p>
      </div>
    </section>
  );
}
