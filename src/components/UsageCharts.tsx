import { useId, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { ChartColumn, Table2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { amountParts, formatDay, formatTick, niceTicks, type AmountUnit, type ScaleKind } from "@/lib/included-usage";
import { UsageBar } from "./PlanUsage";

export type ChartColor = 1 | 2 | 3 | 4;

export const CHART_FILL: Record<ChartColor, string> = {
  1: "bg-chart-1",
  2: "bg-chart-2",
  3: "bg-chart-3",
  4: "bg-chart-4",
};

export interface ChartSeries {
  key: string;
  label: string;
  color: ChartColor;
  values: readonly number[];
}

const AXIS_PX = 20;
const TOP_PX = 8;
const GAP_PX = 2;
const MIN_PX = 2;

export function stackHeights(values: readonly number[], top: number, plot: number): number[] {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0 || top <= 0) return values.map(() => 0);
  const shown = values.filter((value) => value > 0).length;
  const room = Math.max(0, Math.round((total / top) * plot) - GAP_PX * (shown - 1));
  return values.map((value) => (value > 0 ? Math.max(MIN_PX, Math.round((value / total) * room)) : 0));
}

function nextDay(key: string, from: number | null, count: number): number | null {
  const last = count - 1;
  if (last < 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return last;
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  if (from === null) return last;
  return key === "ArrowLeft" ? Math.max(0, from - 1) : Math.min(last, from + 1);
}

function tipPlace(index: number, count: number): CSSProperties {
  return index < count / 2
    ? { left: `calc(${((index + 1) / count) * 100}% + 6px)` }
    : { right: `calc(${((count - index) / count) * 100}% + 6px)` };
}

export function ColumnChart({ days, series, scale, format, label, today, height = 160 }: {
  days: readonly string[];
  series: readonly ChartSeries[];
  scale: ScaleKind;
  format: (value: number) => string;
  label: string;
  today?: string | undefined;
  height?: number;
}) {
  const [active, setActive] = useState<number | null>(null);
  const count = days.length;
  const plot = height - AXIS_PX - TOP_PX;
  const totals = days.map((_, index) => series.reduce((sum, each) => sum + Math.max(0, each.values[index] ?? 0), 0));
  const ticks = niceTicks(Math.max(0, ...totals), scale);
  const top = ticks[ticks.length - 1]!;
  const dayLabel = (index: number) => (today && days[index] === today ? t("usage.chart.today") : formatDay(days[index]!));
  const spoken = active === null ? "" : [
    `${dayLabel(active)}: ${format(totals[active]!)}`,
    ...(series.length > 1 ? series.map((each) => `${each.label} ${format(each.values[active] ?? 0)}`) : []),
  ].join(", ");
  const marks = [...new Set([0, Math.floor((count - 1) / 2), count - 1])].filter((index) => index >= 0);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextDay(event.key, active, count);
    if (next !== null) {
      event.preventDefault();
      setActive(next);
    } else if (event.key === "Escape" && active !== null) {
      event.preventDefault();
      event.stopPropagation();
      setActive(null);
    }
  };

  return (
    <div
      role="group"
      tabIndex={0}
      aria-label={label}
      onKeyDown={onKeyDown}
      onFocus={() => setActive((current) => current ?? (count > 0 ? count - 1 : null))}
      onBlur={() => setActive(null)}
      onMouseLeave={() => setActive(null)}
      className="relative flex select-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
      style={{ height }}
    >
      <div aria-hidden className="relative w-11 shrink-0" style={{ marginTop: TOP_PX, height: plot }}>
        {ticks.map((tick) => (
          <span key={tick} className="absolute right-2 translate-y-1/2 whitespace-nowrap text-[11px] leading-none tabular-nums text-ink-secondary" style={{ bottom: `${(tick / top) * 100}%` }}>
            {formatTick(tick, scale)}
          </span>
        ))}
      </div>
      <div className="relative min-w-0 flex-1">
        <div className="absolute inset-x-0" style={{ top: TOP_PX, height: plot }}>
          {ticks.map((tick) => (
            <div key={tick} aria-hidden className={cn("absolute inset-x-0 border-t", tick === 0 ? "border-hairline" : "border-hairline/40")} style={{ bottom: `${(tick / top) * 100}%` }} />
          ))}
          <div aria-hidden className="absolute inset-0 flex">
            {days.map((day, index) => {
              const heights = stackHeights(series.map((each) => each.values[index] ?? 0), top, plot);
              const topmost = heights.reduce((found, size, at) => (size > 0 ? at : found), -1);
              return (
                <div key={day} className="relative flex flex-1 items-end justify-center" onMouseEnter={() => setActive(index)}>
                  {active === index && <div className="absolute inset-y-0 inset-x-px rounded-sm bg-ink/5" />}
                  <div className={cn("relative flex w-3/5 max-w-3.5 flex-col-reverse gap-0.5 transition-opacity motion-reduce:transition-none", active !== null && active !== index && "opacity-50")}>
                    {series.map((each, at) => heights[at]! > 0 && (
                      <div key={each.key} className={cn(CHART_FILL[each.color], at === topmost && "rounded-t-[4px]")} style={{ height: heights[at] }} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {active !== null && (
            <div className="pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-lg bg-menu px-2.5 py-2 text-[12px] shadow-popover" style={tipPlace(active, count)}>
              <div className="text-ink-secondary">{dayLabel(active)}</div>
              <div className="font-medium tabular-nums text-ink">{format(totals[active]!)}</div>
              {series.length > 1 && (
                <div className="mt-1.5 flex flex-col gap-1">
                  {series.map((each) => (
                    <div key={each.key} className="flex items-center gap-2">
                      <span className={cn("size-2 shrink-0 rounded-[2px]", CHART_FILL[each.color])} />
                      <span className="text-ink-secondary">{each.label}</span>
                      <span className="ml-auto pl-3 tabular-nums text-ink">{format(each.values[active] ?? 0)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div aria-hidden className="absolute inset-x-0 bottom-0 text-[11px] leading-none text-ink-secondary" style={{ height: AXIS_PX }}>
          {marks.map((index) => (
            <span
              key={index}
              className={cn("absolute bottom-0.5 whitespace-nowrap", index === 0 ? "left-0" : index === count - 1 ? "right-0" : "-translate-x-1/2")}
              style={index === 0 || index === count - 1 ? undefined : { left: `${((index + 0.5) / count) * 100}%` }}
            >
              {dayLabel(index)}
            </span>
          ))}
        </div>
      </div>
      <div className="sr-only" aria-live="polite">{spoken}</div>
    </div>
  );
}

export function ChartEmpty({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex h-40 items-center justify-center text-[13px] text-ink-secondary", className)}>{children}</div>;
}

export interface BarRow {
  key: string;
  label: string;
  detail?: string | undefined;
  value: number | null;
  valueLabel: string;
  tip?: ReactNode;
}

export function foldRows(rows: readonly BarRow[], limit: number, format: (value: number) => string): BarRow[] {
  if (rows.length <= limit + 1) return [...rows];
  const rest = rows.slice(limit).reduce((sum, row) => sum + (row.value ?? 0), 0);
  return [...rows.slice(0, limit), { key: "other", label: t("usage.chart.other"), value: rest, valueLabel: format(rest) }];
}

export function BarList({ rows, label, format, limit = 7, color = 1 }: {
  rows: readonly BarRow[];
  label: string;
  format: (value: number) => string;
  limit?: number;
  color?: ChartColor;
}) {
  const [active, setActive] = useState<string | null>(null);
  const tipId = useId();
  const shown = foldRows(rows, limit, format);
  const max = Math.max(0, ...shown.map((row) => row.value ?? 0));
  return (
    <ul role="list" aria-label={label} className="-mx-2 grid grid-cols-[minmax(0,min(10rem,35%))_minmax(0,1fr)_auto] gap-x-3">
      {shown.map((row) => (
        <li
          key={row.key}
          tabIndex={row.tip ? 0 : undefined}
          aria-describedby={row.tip ? `${tipId}-${row.key}` : undefined}
          onMouseEnter={() => setActive(row.key)}
          onMouseLeave={() => setActive(null)}
          onFocus={() => setActive(row.key)}
          onBlur={() => setActive(null)}
          className={cn(
            "relative col-span-3 grid grid-cols-subgrid items-center rounded-md px-2 py-1.5 text-[13px]",
            row.tip && "outline-none focus-visible:ring-2 focus-visible:ring-focus",
            row.tip && active === row.key && "bg-ink/5",
          )}
        >
          <span className="min-w-0">
            <span className="block truncate text-ink" title={row.label}>{row.label}</span>
            {row.detail && <span className="block truncate text-[12px] text-ink-secondary">{row.detail}</span>}
          </span>
          <span aria-hidden className="flex h-2 items-center">
            {row.value !== null && row.value > 0 && max > 0 && (
              <span className={cn("block h-2 rounded-r-[4px]", CHART_FILL[color])} style={{ width: `max(2px, ${(row.value / max) * 100}%)` }} />
            )}
          </span>
          <span className="text-right font-medium tabular-nums text-ink">{row.value === null ? "—" : row.valueLabel}</span>
          {row.tip && (
            <div id={`${tipId}-${row.key}`} role="tooltip" className={cn("pointer-events-none absolute left-2 top-full z-10 mt-1 min-w-48 rounded-lg bg-menu px-2.5 py-2 text-[12px] shadow-popover", active === row.key ? "block" : "hidden")}>
              {row.tip}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function Legend({ items }: { items: readonly { key: string; label: string; color: ChartColor; value?: string | undefined }[] }) {
  return (
    <ul role="list" className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5">
          <span aria-hidden className={cn("size-2 shrink-0 rounded-[2px]", CHART_FILL[item.color])} />
          <span className="text-ink-secondary">{item.label}</span>
          {item.value && <span className="font-medium tabular-nums text-ink">{item.value}</span>}
        </li>
      ))}
    </ul>
  );
}

export type ChartView = "chart" | "table";

const VIEW_OPTIONS = [
  { id: "chart", Icon: ChartColumn, label: "usage.chart.showChart" },
  { id: "table", Icon: Table2, label: "usage.chart.showTable" },
] as const;

export function ViewToggle({ view, onChange }: { view: ChartView; onChange: (view: ChartView) => void }) {
  return (
    <div className="flex shrink-0 rounded-lg bg-inset p-0.5">
      {VIEW_OPTIONS.map(({ id, Icon, label }) => (
        <button
          key={id}
          type="button"
          aria-pressed={view === id}
          aria-label={t(label)}
          title={t(label)}
          onClick={() => onChange(id)}
          className={cn("flex size-6 items-center justify-center rounded-md", view === id ? "bg-control text-ink" : "text-ink-secondary hover:text-ink")}
        >
          <Icon size={13} />
        </button>
      ))}
    </div>
  );
}

export interface Metric {
  key: string;
  label: string;
  value: ReactNode;
  meter?: { used: number; label: string } | undefined;
  detail?: ReactNode;
}

const TILE_COLUMNS: Record<number, string> = {
  2: "grid-cols-2",
  3: "grid-cols-2 @md:grid-cols-3",
  4: "grid-cols-2 @xl:grid-cols-4",
  5: "grid-cols-2 @md:grid-cols-3 @2xl:grid-cols-5",
};

export function MetricTiles({ metrics, selected, onSelect, label }: {
  metrics: readonly Metric[];
  selected: string;
  onSelect: (key: string) => void;
  label: string;
}) {
  return (
    <div className="@container">
      <div role="group" aria-label={label} className={cn("grid gap-1", TILE_COLUMNS[metrics.length] ?? "grid-cols-2")}>
        {metrics.map((metric) => (
          <button
            key={metric.key}
            type="button"
            aria-pressed={selected === metric.key}
            onClick={() => onSelect(metric.key)}
            className={cn(
              "flex min-w-0 flex-col items-stretch gap-1 rounded-lg px-3 py-2.5 text-left transition-colors motion-reduce:transition-none",
              selected === metric.key ? "bg-control" : "hover:bg-control/50",
            )}
          >
            <span className="truncate text-[12px] text-ink-secondary">{metric.label}</span>
            <span className="text-[20px] font-semibold leading-tight text-ink">{metric.value}</span>
            {metric.meter && <UsageBar used={metric.meter.used} label={metric.meter.label} className={cn("mt-1", selected === metric.key && "bg-ink/10")} />}
            {metric.detail && <span className="truncate text-[12px] text-ink-secondary">{metric.detail}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function AmountValue({ value, unit }: { value: number; unit: AmountUnit }) {
  const { before, count, after } = amountParts(value, unit);
  return (
    <span>
      {before && <span className="text-[13px] font-normal text-ink-secondary">{before}</span>}
      {count}
      {after && <span className="text-[13px] font-normal text-ink-secondary">{after}</span>}
    </span>
  );
}

export interface TableColumn {
  key: string;
  label: string;
  align?: "left" | "right";
}

export function DataTable({ columns, rows, label }: {
  columns: readonly TableColumn[];
  rows: readonly { key: string; cells: readonly ReactNode[] }[];
  label: string;
}) {
  const right = (index: number) => columns[index]?.align === "right";
  return (
    <table className="w-full border-collapse text-[13px]">
      <caption className="sr-only">{label}</caption>
      <thead>
        <tr className="border-b border-hairline/40 text-[11.5px] uppercase tracking-wide text-ink-secondary">
          {columns.map((column, index) => (
            <th key={column.key} scope="col" className={cn("pb-2 font-medium", right(index) ? "text-right" : "text-left", index > 0 && "pl-5")}>{column.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className="border-b border-hairline/20 last:border-b-0">
            {row.cells.map((cell, index) => index === 0
              ? <th key={columns[index]?.key ?? index} scope="row" className="py-2 text-left font-normal text-ink">{cell}</th>
              : <td key={columns[index]?.key ?? index} className={cn("py-2 pl-5 text-ink", right(index) ? "text-right tabular-nums" : "text-left")}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
