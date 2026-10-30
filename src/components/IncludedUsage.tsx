import { useState } from "react";
import { t } from "@/lib/i18n";
import {
  INCLUDED_SERVICE_DEFS,
  formatAmount,
  formatDay,
  serviceUsed,
  serviceUsedPercent,
  useIncludedUsage,
  type IncludedServiceId,
} from "@/lib/included-usage";
import { usageLeft } from "./AccountCharge";
import { AmountValue, ChartEmpty, ColumnChart, DataTable, MetricTiles, ViewToggle, type ChartView } from "./UsageCharts";

export function IncludedUsage() {
  const { usage } = useIncludedUsage();
  const [selected, setSelected] = useState<IncludedServiceId>("dictation");
  const [view, setView] = useState<ChartView>("chart");
  if (!usage) return null;

  const service = INCLUDED_SERVICE_DEFS.find((each) => each.id === selected) ?? INCLUDED_SERVICE_DEFS[0]!;
  const todayUsed = usage.days.find((each) => each.day === usage.today)?.used ?? {};
  const metrics = INCLUDED_SERVICE_DEFS.map((each) => {
    const used = serviceUsedPercent(todayUsed, usage.limits, each);
    return {
      key: each.id,
      label: t(each.label),
      value: <AmountValue value={serviceUsed(todayUsed, each)} unit={each.unit} />,
      meter: used === null ? undefined : { used, label: t(each.label) },
      detail: used !== null ? t("planUsage.left", { left: usageLeft(used) }) : usage.owner ? t("usage.included.noLimit") : undefined,
    };
  });
  const days = usage.days.map((each) => each.day);
  const values = usage.days.map((each) => serviceUsed(each.used, service));
  const format = (value: number) => formatAmount(value, service.unit);
  const title = t("usage.included.last30", { service: t(service.label) });
  const dayName = (day: string) => (day === usage.today ? t("usage.chart.today") : formatDay(day));

  return (
    <section data-included-usage="" className="flex flex-col gap-1.5">
      <h3 className="px-4 text-[12px] font-medium text-ink-secondary">{t("usage.included.title")}</h3>
      <div className="flex flex-col gap-4 rounded-xl bg-card px-4 py-3">
        <div className="flex flex-col gap-2">
          <p className="text-[12px] text-ink-secondary">{t("usage.included.today")}</p>
          <MetricTiles metrics={metrics} selected={service.id} onSelect={(key) => setSelected(key as IncludedServiceId)} label={t("usage.included.today")} />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] text-ink-secondary">{title}</p>
            <ViewToggle view={view} onChange={setView} />
          </div>
          {values.every((value) => value <= 0)
            ? <ChartEmpty>{t("usage.history.empty")}</ChartEmpty>
            : view === "chart"
              ? <ColumnChart days={days} series={[{ key: service.id, label: t(service.label), color: 1, values }]} scale={service.unit === "duration" ? "duration" : "count"} format={format} label={title} today={usage.today} />
              : (
                <DataTable
                  label={title}
                  columns={[{ key: "day", label: t("usage.history.byDay") }, { key: "used", label: t(service.label), align: "right" }]}
                  rows={days.flatMap((day, index) => (values[index]! > 0 ? [{ key: day, cells: [dayName(day), format(values[index]!)] }] : [])).reverse()}
                />
              )}
        </div>
        {!usage.owner && usage.limits && <p className="text-[12px] leading-relaxed text-ink-secondary">{t("accounts.included.allowance")}</p>}
      </div>
    </section>
  );
}
