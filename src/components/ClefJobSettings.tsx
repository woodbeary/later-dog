import { useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { SettingRow, Switch } from "./SettingsPrimitives";

type Job = "autoReview" | "turnEnd" | "screenCheck" | "screenshotFilter";

const JOBS: ReadonlyArray<{ id: Job; title: "settings.clef.autoReview.title" | "settings.clef.turnEnd.title" | "settings.clef.screenCheck.title" | "settings.clef.screenshotFilter.title"; body: "settings.clef.autoReview.body" | "settings.clef.turnEnd.body" | "settings.clef.screenCheck.body" | "settings.clef.screenshotFilter.body" }> = [
  { id: "autoReview", title: "settings.clef.autoReview.title", body: "settings.clef.autoReview.body" },
  { id: "turnEnd", title: "settings.clef.turnEnd.title", body: "settings.clef.turnEnd.body" },
  { id: "screenCheck", title: "settings.clef.screenCheck.title", body: "settings.clef.screenCheck.body" },
  { id: "screenshotFilter", title: "settings.clef.screenshotFilter.title", body: "settings.clef.screenshotFilter.body" },
];

export function ClefJobSettings() {
  const { state, dispatch } = useStore();
  const clef = state.config?.clef;
  const [busy, setBusy] = useState<Job | null>(null);
  const [failed, setFailed] = useState(false);
  if (!clef) return null;

  const toggle = async (job: Job, on: boolean) => {
    setBusy(job);
    setFailed(false);
    try {
      const config = await api<ConfigStatus>("/api/config", {
        method: "PUT",
        body: JSON.stringify({ decider: { jobs: { [job]: on } } }),
        timeoutMs: 10_000,
      });
      dispatch({ type: "configStatus", config });
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-clef-jobs="">
      {JOBS.map((job) => {
        const on = clef.jobs[job.id];
        const available = clef.available?.[job.id] !== false;
        return (
          <SettingRow key={job.id} title={t(job.title)} subtitle={t(job.body, { where: clef.sendsTo ?? "" })}>
            <div className="flex flex-col items-end gap-1">
              <Switch
                aria-label={t(job.title)}
                checked={on}
                disabled={busy === job.id}
                onClick={() => void toggle(job.id, !on)}
              />
              {on && !available && <span className="max-w-[14rem] text-right text-[12px] text-ink-secondary">{t("settings.clef.unavailable")}</span>}
            </div>
          </SettingRow>
        );
      })}
      {failed && <div role="status" className="py-2 text-[12px] text-danger">{t("settings.clef.saveError")}</div>}
    </div>
  );
}
