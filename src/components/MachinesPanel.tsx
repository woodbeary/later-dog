import { useCallback, useEffect, useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { SettingRow, SettingsRows, Switch } from "./SettingsPrimitives";

export interface MachineLineView {
  settings: { cap: number; idleMinutes: number };
  max: number;
  running: Array<{ id: string; size: "small" | "large"; busy: boolean }>;
  waiting: Array<{ id: string }>;
}

export interface TaskMachinesView {
  enabled: boolean;
  bots?: string[];
  line?: MachineLineView;
  lineError?: string;
}

const CAPS = [1, 2, 3, 5, 10, 15, 20, 30, 40, 50, 75, 100];
const IDLE_MINUTES = [2, 5, 10, 15, 30];

export function machinesSummary(line: MachineLineView | undefined): string {
  if (!line) return t("machines.none");
  const busy = line.running.filter((machine) => machine.busy).length;
  const large = line.running.filter((machine) => machine.size === "large").length;
  const parts = [
    line.running.length === 0 ? t("machines.none") : t("machines.running", { count: String(line.running.length), busy: String(busy), large: String(large) }),
    ...(line.waiting.length ? [t("machines.waiting", { count: String(line.waiting.length) })] : []),
  ];
  return parts.join(" · ");
}

export function MachinesPanel() {
  const [view, setView] = useState<TaskMachinesView | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(() => {
    api<TaskMachinesView>("/api/task-machines", { timeoutMs: 15_000 }).then(setView).catch(() => setView(null));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const save = (change: { enabled?: boolean; cap?: number; idleMinutes?: number }) => {
    if (!view) return;
    setSaving(true);
    setFailed(null);
    api<TaskMachinesView>("/api/task-machines", {
      method: "PUT",
      body: JSON.stringify({ enabled: change.enabled ?? view.enabled, ...(view.bots ? { bots: view.bots } : {}), ...(change.cap === undefined ? {} : { cap: change.cap }), ...(change.idleMinutes === undefined ? {} : { idleMinutes: change.idleMinutes }) }),
    })
      .then(setView)
      .catch((error: Error) => setFailed(error.message))
      .finally(() => setSaving(false));
  };

  if (!view) return null;
  const cap = view.line?.settings.cap;
  const idle = view.line?.settings.idleMinutes;
  const max = view.line?.max ?? 100;
  return (
    <SettingsRows data-machines-panel="">
      <SettingRow
        title={t("machines.title")}
        subtitle={view.enabled ? (view.bots ? t("machines.someDogs", { count: String(view.bots.length) }) : t("machines.allDogs")) : t("machines.off")}
        message={failed ? <span className="text-danger">{failed}</span> : view.lineError ? <span className="text-ink-secondary">{view.lineError}</span> : undefined}
      >
        <Switch checked={view.enabled} disabled={saving} aria-label={t("machines.title")} onClick={() => save({ enabled: !view.enabled })} />
      </SettingRow>
      {view.line && (
        <>
          <SettingRow title={t("machines.cap")} subtitle={t("machines.capHint")}>
            <select
              value={cap}
              disabled={saving}
              aria-label={t("machines.cap")}
              onChange={(event) => save({ cap: Number(event.target.value) })}
              className="min-h-8 w-full max-w-[240px] rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[13px] text-ink focus:border-focus disabled:cursor-wait disabled:opacity-50"
            >
              {[...new Set([...CAPS.filter((value) => value <= max), ...(cap ? [cap] : [])])].sort((a, b) => a - b).map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </SettingRow>
          <SettingRow title={t("machines.idle")} subtitle={t("machines.idleHint")}>
            <select
              value={idle}
              disabled={saving}
              aria-label={t("machines.idle")}
              onChange={(event) => save({ idleMinutes: Number(event.target.value) })}
              className="min-h-8 w-full max-w-[240px] rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[13px] text-ink focus:border-focus disabled:cursor-wait disabled:opacity-50"
            >
              {[...new Set([...IDLE_MINUTES, ...(idle ? [idle] : [])])].sort((a, b) => a - b).map((value) => (
                <option key={value} value={value}>{t("machines.minutes", { count: String(value) })}</option>
              ))}
            </select>
          </SettingRow>
          <SettingRow title={t("machines.now")}>
            <span data-machines-now="" className="text-[13px] text-ink-secondary">{machinesSummary(view.line)}</span>
          </SettingRow>
        </>
      )}
    </SettingsRows>
  );
}
