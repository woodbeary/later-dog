import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import {
  INCLUDED_SERVICE_DEFS,
  PROVIDER_LABEL,
  SPEND_SERVICE_INFO,
  amountParts,
  fetchOwnerReport,
  formatAmount,
  formatCount,
  formatDay,
  formatGrant,
  formatMoney,
  microsToUsd,
  saveGrants,
  serviceUsed,
  type AmountUnit,
} from "@/lib/included-usage";
import {
  SPEND_PROVIDERS,
  grantProblem,
  type Grant,
  type GrantSpend,
  type InstallTier,
  type OwnerReport,
  type SpendProvider,
  type TopInstall,
  type UsageAmounts,
} from "../../shared/included-usage";
import { usageLeft } from "./AccountCharge";
import { usageValueClass } from "./AccountBattery";
import { UsageBar } from "./PlanUsage";
import { SettingRow } from "./SettingsPrimitives";
import {
  AmountValue,
  BarList,
  ChartEmpty,
  ColumnChart,
  DataTable,
  Legend,
  MetricTiles,
  ViewToggle,
  type BarRow,
  type ChartColor,
  type ChartSeries,
  type ChartView,
} from "./UsageCharts";

const REPORT_DAYS = 30;
const USE_SERVICES: readonly string[] = ["dictation", "voice", "chat"];

export const PROVIDER_COLOR: Record<SpendProvider, ChartColor> = { elevenlabs: 1, cloudflare: 2, xai: 3, anthropic: 4 };

const TIER_LABEL: Record<InstallTier, LocaleKey> = {
  trial: "dashboard.tier.trial",
  home: "dashboard.tier.home",
  plan: "dashboard.tier.plan",
  owner: "dashboard.tier.owner",
};

const HEADER_BUTTON = "rounded-md text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-45";

type MeasureUnit = AmountUnit | "count";

export interface UseMeasure {
  key: string;
  label: string;
  unit: MeasureUnit;
  values: number[];
  total: number;
  today: number;
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

export const measureText = (value: number, unit: MeasureUnit): string => (unit === "count" ? formatCount(value) : formatAmount(value, unit));

export function usageMeasures(report: OwnerReport): UseMeasure[] {
  const byDay = new Map<string, UsageAmounts>();
  for (const row of report.usage) {
    const used = byDay.get(row.day) ?? {};
    used[row.kind] = (used[row.kind] ?? 0) + row.used;
    byDay.set(row.day, used);
  }
  const at = report.days.indexOf(report.today);
  const services = INCLUDED_SERVICE_DEFS.filter((def) => USE_SERVICES.includes(def.id)).map((def): UseMeasure => {
    const values = report.days.map((day) => serviceUsed(byDay.get(day) ?? {}, def));
    return { key: def.id, label: t(def.label), unit: def.unit, values, total: sum(values), today: at < 0 ? 0 : values[at] ?? 0 };
  });
  const active = new Map(report.active.map((row) => [row.day, row.installs]));
  return [
    ...services,
    {
      key: "active",
      label: t("dashboard.activeUsers"),
      unit: "count",
      values: report.days.map((day) => active.get(day) ?? 0),
      total: report.activeInstalls,
      today: active.get(report.today) ?? 0,
    },
  ];
}

export function spendSeries(report: OwnerReport): ChartSeries[] {
  const index = new Map(report.days.map((day, at) => [day, at]));
  const micros = new Map<SpendProvider, number[]>();
  for (const row of report.spend) {
    const at = index.get(row.day);
    if (at === undefined || row.micros <= 0) continue;
    const list = micros.get(row.provider) ?? report.days.map(() => 0);
    list[at] = (list[at] ?? 0) + row.micros;
    micros.set(row.provider, list);
  }
  return SPEND_PROVIDERS.flatMap((provider) => {
    const list = micros.get(provider);
    return list ? [{ key: provider, label: t(PROVIDER_LABEL[provider]), color: PROVIDER_COLOR[provider], values: list.map(microsToUsd) }] : [];
  });
}

export function installName(install: Pick<TopInstall, "label" | "owner">): string {
  if (install.owner) return t("dashboard.top.you");
  return /^trl_[a-z2-7]{6}/.test(install.label) ? t("dashboard.top.user", { id: install.label.slice(4, 10) }) : t("dashboard.top.removed");
}

function ServiceTip({ services }: { services: TopInstall["services"] }) {
  return (
    <dl className="grid grid-cols-[auto_auto_auto] gap-x-3 gap-y-1">
      {services.map((each) => (
        <Fragment key={each.service}>
          <dt className="text-ink-secondary">{t(SPEND_SERVICE_INFO[each.service].label)}</dt>
          <dd className="tabular-nums text-ink">{formatAmount(each.units, SPEND_SERVICE_INFO[each.service].unit)}</dd>
          <dd className="text-right tabular-nums text-ink">{formatMoney(microsToUsd(each.micros))}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function topRows(top: readonly TopInstall[]): BarRow[] {
  return top.map((install, index) => {
    const usd = microsToUsd(install.micros);
    return {
      key: `install-${index}`,
      label: installName(install),
      detail: install.owner ? undefined : install.tier ? t(TIER_LABEL[install.tier]) : t("dashboard.top.ended"),
      value: usd,
      valueLabel: formatMoney(usd),
      tip: install.services.length > 0 ? <ServiceTip services={install.services} /> : undefined,
    };
  });
}

function Panel({ title, action, children, card = true, ...data }: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  card?: boolean;
} & Record<`data-${string}`, string>) {
  return (
    <section {...data} className="flex flex-col gap-1.5">
      <div className="flex min-h-[25px] items-center justify-between gap-3 pl-4">
        <h3 className="text-[12px] font-medium text-ink-secondary">{title}</h3>
        {action}
      </div>
      {card ? <div className="flex flex-col gap-4 rounded-xl bg-card px-4 py-3">{children}</div> : children}
    </section>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return <p className="text-[12px] text-ink-secondary">{children}</p>;
}

function UseCard({ report, refresh, loading }: { report: OwnerReport; refresh: () => void; loading: boolean }) {
  const [selected, setSelected] = useState("dictation");
  const [view, setView] = useState<ChartView>("chart");
  const measures = usageMeasures(report);
  const measure = measures.find((each) => each.key === selected) ?? measures[0]!;
  const format = (value: number) => measureText(value, measure.unit);
  const caption = t("dashboard.byDay", { name: measure.label });
  const dayName = (day: string) => (day === report.today ? t("usage.chart.today") : formatDay(day));
  const metrics = measures.map((each) => ({
    key: each.key,
    label: each.label,
    value: each.unit === "count" ? formatCount(each.total) : <AmountValue value={each.total} unit={each.unit} />,
    detail: t("dashboard.today", { value: each.unit === "count" ? formatCount(each.today) : amountParts(each.today, each.unit).count }),
  }));

  return (
    <Panel
      data-dashboard-use=""
      title={t("dashboard.use.title")}
      action={(
        <button type="button" onClick={refresh} disabled={loading} aria-label={t("planUsage.refresh")} title={t("planUsage.refresh")} className={cn(HEADER_BUTTON, "p-1.5")}>
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
      )}
    >
      <div className="flex flex-col gap-2">
        <Caption>{t("usage.history.last30Days")}</Caption>
        <MetricTiles metrics={metrics} selected={measure.key} onSelect={setSelected} label={t("usage.history.last30Days")} />
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <Caption>{caption}</Caption>
          <ViewToggle view={view} onChange={setView} />
        </div>
        {measure.values.every((value) => value <= 0)
          ? <ChartEmpty>{t("usage.history.empty")}</ChartEmpty>
          : view === "chart"
            ? <ColumnChart days={report.days} series={[{ key: measure.key, label: measure.label, color: 1, values: measure.values }]} scale={measure.unit === "duration" ? "duration" : "count"} format={format} label={caption} today={report.today} />
            : (
              <DataTable
                label={caption}
                columns={[{ key: "day", label: t("usage.history.byDay") }, { key: "used", label: measure.label, align: "right" }]}
                rows={report.days.flatMap((day, at) => (measure.values[at]! > 0 ? [{ key: day, cells: [dayName(day), format(measure.values[at]!)] }] : [])).reverse()}
              />
            )}
      </div>
    </Panel>
  );
}

function SpendCard({ report }: { report: OwnerReport }) {
  const [view, setView] = useState<ChartView>("chart");
  const series = spendSeries(report);
  const totals = series.map((each) => sum(each.values));
  const title = t("dashboard.spend.title");
  const dayName = (day: string) => (day === report.today ? t("usage.chart.today") : formatDay(day));
  const rows = report.days.flatMap((day, at) => {
    const values = series.map((each) => each.values[at] ?? 0);
    const total = sum(values);
    return total > 0 ? [{ key: day, cells: [dayName(day), ...values.map(formatMoney), formatMoney(total)] }] : [];
  }).reverse();

  return (
    <Panel data-dashboard-spend="" title={title}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[22px] font-semibold text-ink">{formatMoney(sum(totals))}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("dashboard.spend.caption")}</p>
        </div>
        {series.length > 0 && <ViewToggle view={view} onChange={setView} />}
      </div>
      {series.length === 0
        ? <ChartEmpty className="h-24">{t("dashboard.spend.empty")}</ChartEmpty>
        : (
          <div className="flex flex-col gap-3">
            <Legend items={series.map((each, at) => ({ key: each.key, label: each.label, color: each.color, value: formatMoney(totals[at]!) }))} />
            {view === "chart"
              ? <ColumnChart days={report.days} series={series} scale="money" format={formatMoney} label={title} today={report.today} />
              : (
                <DataTable
                  label={title}
                  columns={[
                    { key: "day", label: t("usage.history.byDay") },
                    ...series.map((each) => ({ key: each.key, label: each.label, align: "right" as const })),
                    { key: "total", label: t("usage.history.total"), align: "right" },
                  ]}
                  rows={rows}
                />
              )}
          </div>
        )}
    </Panel>
  );
}

function TopUsers({ report }: { report: OwnerReport }) {
  const title = t("dashboard.top.title");
  const rows = topRows(report.top);
  return (
    <Panel data-dashboard-top="" title={title}>
      {rows.length === 0
        ? <ChartEmpty className="h-24">{t("dashboard.spend.empty")}</ChartEmpty>
        : <BarList rows={rows} label={title} format={formatMoney} />}
    </Panel>
  );
}

interface GrantDraft {
  usd: string;
  since: string;
}

type GrantDrafts = Record<SpendProvider, GrantDraft>;

export function grantDrafts(grants: readonly Grant[], today: string): GrantDrafts {
  const out = {} as GrantDrafts;
  for (const provider of SPEND_PROVIDERS) {
    const grant = grants.find((each) => each.provider === provider);
    out[provider] = { usd: grant ? String(grant.usd) : "", since: grant?.since ?? today };
  }
  return out;
}

export function grantsFromDrafts(drafts: GrantDrafts): Grant[] {
  return SPEND_PROVIDERS.flatMap((provider) => {
    const { usd, since } = drafts[provider];
    return usd.trim() === "" ? [] : [{ provider, usd: Number(usd), since }];
  });
}

const FIELD = "min-h-8 w-full rounded-lg border border-hairline/40 bg-inset py-1.5 text-[13px] text-ink focus:border-focus focus:outline-none [color-scheme:var(--code-color-scheme)]";

function Grants({ grants, today, onSaved }: { grants: readonly GrantSpend[]; today: string; onSaved: (grants: GrantSpend[]) => void }) {
  const [drafts, setDrafts] = useState<GrantDrafts | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const edit = () => {
    setDrafts(grantDrafts(grants, today));
    setFailed(false);
  };
  const change = (provider: SpendProvider, field: keyof GrantDraft, value: string) =>
    setDrafts((current) => current && { ...current, [provider]: { ...current[provider], [field]: value } });
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!drafts || busy) return;
    const next = grantsFromDrafts(drafts);
    if (grantProblem(next)) {
      setFailed(true);
      return;
    }
    setBusy(true);
    setFailed(false);
    void saveGrants(next)
      .then((saved) => {
        onSaved(saved);
        setDrafts(null);
      }, () => setFailed(true))
      .finally(() => setBusy(false));
  };

  return (
    <Panel
      data-dashboard-grants=""
      title={t("dashboard.grants.title")}
      card={false}
      action={drafts ? undefined : <button type="button" onClick={edit} className={cn(HEADER_BUTTON, "px-2 py-1 text-[12px] font-medium")}>{t("dashboard.grants.edit")}</button>}
    >
      <form onSubmit={save} noValidate className="rounded-xl bg-card px-4">
        {SPEND_PROVIDERS.map((provider) => {
          const name = t(PROVIDER_LABEL[provider]);
          const grant = grants.find((each) => each.provider === provider);
          const spent = grant ? microsToUsd(grant.spentMicros) : 0;
          const share = grant && grant.usd > 0 ? (spent / grant.usd) * 100 : 0;
          const draft = drafts?.[provider];
          return (
            <SettingRow
              key={provider}
              title={name}
              subtitle={grant ? t("dashboard.grants.spent", { spent: formatMoney(spent), total: formatGrant(grant.usd), since: formatDay(grant.since) }) : t("dashboard.grants.none")}
            >
              {draft ? (
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <label className="relative block">
                    <span aria-hidden className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-[13px] text-ink-secondary">$</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="any"
                      value={draft.usd}
                      onChange={(event) => change(provider, "usd", event.target.value)}
                      aria-label={t("dashboard.grants.amount", { provider: name })}
                      className={cn(FIELD, "pl-6 pr-2 tabular-nums")}
                    />
                  </label>
                  <input
                    type="date"
                    value={draft.since}
                    max={today}
                    onChange={(event) => change(provider, "since", event.target.value)}
                    aria-label={t("dashboard.grants.since", { provider: name })}
                    className={cn(FIELD, "px-2")}
                  />
                </div>
              ) : grant ? (
                <span className="flex items-center gap-3 sm:w-[200px]">
                  <UsageBar used={share} label={name} className="min-w-0 flex-1" />
                  <span className={cn("min-w-[58px] shrink-0 text-right text-[12px] tabular-nums", usageValueClass(share))}>{t("planUsage.left", { left: usageLeft(share) })}</span>
                </span>
              ) : null}
            </SettingRow>
          );
        })}
        {drafts && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-hairline/40 py-3">
            {failed && <p role="alert" className="mr-auto text-[12px] text-danger">{t("dashboard.grants.error")}</p>}
            <button type="button" className="ui-button" onClick={() => setDrafts(null)} disabled={busy}>{t("common.cancel")}</button>
            <button type="submit" className="ui-button" disabled={busy}>{t("common.save")}</button>
          </div>
        )}
      </form>
    </Panel>
  );
}

export function OwnerDashboard() {
  const [report, setReport] = useState<OwnerReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    let current = true;
    setLoading(true);
    fetchOwnerReport(REPORT_DAYS)
      .then((next) => {
        if (!current) return;
        if (next) setReport(next);
        setFailed(!next);
      }, () => {
        if (current) setFailed(true);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [asked]);

  const refresh = () => setAsked((count) => count + 1);

  if (!report) {
    if (loading) return <p className="px-4 text-[13px] text-ink-secondary">{t("common.checking")}</p>;
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl bg-card px-4 py-3">
        <p role="alert" className="text-[13px] text-danger">{t("dashboard.error")}</p>
        <button type="button" className="ui-button" onClick={refresh}>{t("planUsage.refresh")}</button>
      </div>
    );
  }

  return (
    <div data-owner-dashboard="" aria-busy={loading} className={cn("flex flex-col gap-6 transition-opacity motion-reduce:transition-none", loading && "opacity-60")}>
      {failed && <p role="alert" className="px-4 text-[12px] text-danger">{t("dashboard.error")}</p>}
      <UseCard report={report} refresh={refresh} loading={loading} />
      <SpendCard report={report} />
      <TopUsers report={report} />
      <Grants grants={report.grants} today={report.today} onSaved={(grants) => setReport((current) => current && { ...current, grants })} />
    </div>
  );
}
