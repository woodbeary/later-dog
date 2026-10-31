import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { ColumnChart, type ChartColor } from "./UsageCharts";

export interface GitHubDay { day: string; commits: number; prs: number }
export type GitHubActivity =
  | { state: "signedOut" }
  | { state: "ready"; login: string; today: string; days: GitHubDay[] }
  | { state: "unavailable"; message: string };

export function fetchGitHubActivity(): Promise<GitHubActivity> {
  return api("/api/usage/github");
}

const count = (value: number) => String(Math.round(value));
const sum = (days: readonly GitHubDay[], pick: (day: GitHubDay) => number) => days.reduce((total, day) => total + pick(day), 0);

function Quiet({ children }: { children: string }) {
  return <p className="text-[12.5px] leading-relaxed text-ink-secondary">{children}</p>;
}

function Activity({ activity }: { activity: Extract<GitHubActivity, { state: "ready" }> }) {
  const days = activity.days.map((each) => each.day);
  const today = activity.days.find((each) => each.day === activity.today);
  const charts: { key: string; label: string; color: ChartColor; pick: (day: GitHubDay) => number }[] = [
    { key: "commits", label: t("usage.github.commits"), color: 2, pick: (day) => day.commits },
    { key: "prs", label: t("usage.github.prs"), color: 3, pick: (day) => day.prs },
  ];
  const stats = [
    { key: "commits", label: t("usage.github.commitsToday"), value: count(today?.commits ?? 0) },
    { key: "prs", label: t("usage.github.prsToday"), value: count(today?.prs ?? 0) },
    { key: "month", label: t("usage.history.last30Days"), value: t("usage.github.totals", { commits: count(sum(activity.days, (day) => day.commits)), prs: count(sum(activity.days, (day) => day.prs)) }) },
  ];
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-wrap gap-x-8 gap-y-2">
        {stats.map((stat) => (
          <div key={stat.key} className="flex flex-col">
            <dt className="text-[12px] text-ink-secondary">{stat.label}</dt>
            <dd className="text-[15px] font-medium tabular-nums text-ink">{stat.value}</dd>
          </div>
        ))}
      </dl>
      {charts.map((chart) => (
        <div key={chart.key} data-github-chart={chart.key} className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-secondary">{chart.label}</span>
          <ColumnChart
            days={days}
            series={[{ key: chart.key, label: chart.label, color: chart.color, values: activity.days.map(chart.pick) }]}
            scale="count"
            format={count}
            label={`${chart.label} · ${t("usage.history.last30Days")}`}
            today={activity.today}
            height={96}
          />
        </div>
      ))}
    </div>
  );
}

export function UsageGitHub({ load = fetchGitHubActivity }: { load?: typeof fetchGitHubActivity }) {
  const [activity, setActivity] = useState<GitHubActivity | null>(null);
  useEffect(() => {
    let current = true;
    load()
      .then((next) => { if (current) setActivity(next); })
      .catch((error) => { if (current) setActivity({ state: "unavailable", message: error instanceof Error ? error.message : String(error) }); });
    return () => { current = false; };
  }, [load]);
  if (activity && !["ready", "signedOut", "unavailable"].includes(activity.state)) return null;
  return (
    <section data-usage-github={activity?.state ?? "checking"} className="flex flex-col gap-1.5">
      <h3 className="px-4 text-[12px] font-medium text-ink-secondary">{t("usage.github.title")}</h3>
      <div className="rounded-xl bg-card px-4 py-3">
        {!activity ? <Quiet>{t("common.checking")}</Quiet>
          : activity.state === "ready" ? <Activity activity={activity} />
          : activity.state === "signedOut" ? <Quiet>{t("usage.github.signedOut")}</Quiet>
          : <Quiet>{t("usage.github.unavailable")}</Quiet>}
      </div>
    </section>
  );
}
