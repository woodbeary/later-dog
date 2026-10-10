import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/state/store";
import { openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import { pillButton } from "./LocalVmRows";
import { SettingRow } from "./SettingsPrimitives";

export type TrialStatus =
  | { state: "none" }
  | { state: "offered"; minutes: number; days: number }
  | { state: "pending"; url: string }
  | { state: "active"; minutes: number; minutesLeft: number; expiresAt: string }
  | { state: "used_up"; minutes: number; expiresAt: string }
  | { state: "ended" };

const TRIAL_PATH = "/api/computers/trial";
const POLL_MS: Partial<Record<TrialStatus["state"], number>> = { pending: 3_000, active: 30_000 };

const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function trialSubtitle(status: TrialStatus): string {
  switch (status.state) {
    case "offered": return t("vm.trial.offer", { minutes: status.minutes, days: status.days });
    case "pending": return t("vm.trial.pending");
    case "active": return status.minutesLeft === 1 ? t("vm.trial.left.one") : t("vm.trial.left", { minutes: status.minutesLeft });
    case "used_up": return t("vm.trial.usedUp", { minutes: status.minutes });
    default: return "";
  }
}

export function CloudTrialRow() {
  const [status, setStatus] = useState<TrialStatus>({ state: "none" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<TrialStatus>(TRIAL_PATH, { signal: controller.signal })
      .then(setStatus, (cause) => { if (!controller.signal.aborted) setError(messageOf(cause)); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const ms = POLL_MS[status.state];
    if (!ms) return;
    const controller = new AbortController();
    let timer = window.setTimeout(function check() {
      void api<TrialStatus>(TRIAL_PATH, { signal: controller.signal })
        .then(setStatus, () => {})
        .finally(() => { if (!controller.signal.aborted) timer = window.setTimeout(check, ms); });
    }, ms);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [status.state]);

  const act = async (method: "POST" | "DELETE") => {
    setBusy(true);
    setError(null);
    try {
      const next = await api<TrialStatus>(TRIAL_PATH, { method });
      setStatus(next);
      if (method === "POST" && next.state === "pending") await openExternalLink(next.url);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const end = () => {
    if (window.confirm(t("vm.trial.endConfirm"))) void act("DELETE");
  };

  const spinner = busy && <Loader2 size={12} className="animate-spin" />;

  return (
    <>
      {status.state === "ended" ? (
        <p data-cloud-trial="ended" className="border-t border-hairline/40 py-4 text-[12px] text-ink-secondary">{t("vm.trial.ended")}</p>
      ) : status.state !== "none" && (
        <SettingRow title={t("vm.trial.title")} subtitle={trialSubtitle(status)}>
          <div data-cloud-trial={status.state} className="flex flex-wrap gap-2 sm:justify-end">
            {status.state === "offered" && (
              <button type="button" onClick={() => void act("POST")} disabled={busy} className={`${pillButton} flex items-center gap-1.5`}>
                {spinner}
                {t("vm.trial.start")}
              </button>
            )}
            {status.state === "pending" && (
              <>
                <button type="button" onClick={() => void openExternalLink(status.url)} disabled={busy} className={pillButton}>
                  {t("vm.trial.open")}
                </button>
                <button type="button" onClick={() => void act("DELETE")} disabled={busy} className={`${pillButton} flex items-center gap-1.5`}>
                  {spinner}
                  {t("common.cancel")}
                </button>
              </>
            )}
            {(status.state === "active" || status.state === "used_up") && (
              <button type="button" onClick={end} disabled={busy} className={`${pillButton} flex items-center gap-1.5 text-danger`}>
                {spinner}
                {t("vm.trial.end")}
              </button>
            )}
          </div>
        </SettingRow>
      )}
      {error && <p role="alert" className="border-t border-hairline/40 py-3 text-[12px] text-danger">{error}</p>}
    </>
  );
}
