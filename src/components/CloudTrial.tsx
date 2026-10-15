import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/state/store";
import { openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import { pillButton } from "./LocalVmRows";
import { SettingRow } from "./SettingsPrimitives";

export type PlanInfo = { status: "none" | "pending" | "active" | "canceled" | "ended"; periodEnd?: string };

export type TrialStatus =
  | { state: "none" }
  | { state: "offered"; minutes: number; days: number; ai?: true }
  | { state: "pending"; url: string }
  | { state: "active"; minutes: number; minutesLeft: number; expiresAt: string; plan?: PlanInfo; planOffered?: true; ai?: true }
  | { state: "used_up"; minutes: number; expiresAt: string; plan?: PlanInfo; planOffered?: true; ai?: true }
  | { state: "ended"; planOffered?: true };

const PLAN_PATH = "/api/computers/plan";
const CHECKOUT_POLL_MS = 4_000;
const CHECKOUT_WAIT_MS = 15 * 60_000;

export const onPlan = (status: TrialStatus | null) =>
  (status?.state === "active" || status?.state === "used_up") && (status.plan?.status === "active" || status.plan?.status === "canceled");

export const mayBuyPlan = (status: TrialStatus | null) =>
  !onPlan(status) && (status?.state === "used_up" || status?.state === "ended" || status?.state === "active") && status.planOffered === true
  && (status.state !== "active" || status.minutesLeft < 10);

const TRIAL_PATH = "/api/computers/trial";
const POLL_MS: Partial<Record<TrialStatus["state"], number>> = { pending: 3_000, active: 30_000 };

const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function trialSubtitle(status: TrialStatus): string {
  if ((status.state === "active" || status.state === "used_up") && onPlan(status)) {
    const until = status.plan?.periodEnd ? new Date(status.plan.periodEnd).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
    if (status.plan?.status === "canceled") return t("vm.plan.until", { date: until });
    const hours = status.state === "active" ? Math.floor(status.minutesLeft / 60) : 0;
    return hours === 1 ? t("vm.plan.left.one") : t("vm.plan.left", { hours });
  }
  switch (status.state) {
    case "offered": return t("vm.trial.offer");
    case "pending": return t("vm.trial.pending");
    case "active": return status.minutesLeft === 1 ? t("vm.trial.left.one") : t("vm.trial.left", { minutes: status.minutesLeft });
    case "used_up": return t("vm.trial.usedUp", { minutes: status.minutes });
    default: return "";
  }
}

export function useCloudTrial() {
  const [status, setStatus] = useState<TrialStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<TrialStatus>(TRIAL_PATH, { signal: controller.signal })
      .then(setStatus, (cause) => { if (!controller.signal.aborted) setError(messageOf(cause)); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const ms = status && POLL_MS[status.state];
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
  }, [status?.state]);

  const [checkoutUntil, setCheckoutUntil] = useState(0);

  useEffect(() => {
    if (!checkoutUntil) return;
    if (onPlan(status) || Date.now() > checkoutUntil) {
      setCheckoutUntil(0);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<TrialStatus>(TRIAL_PATH, { signal: controller.signal }).then(setStatus, () => {});
    }, CHECKOUT_POLL_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [checkoutUntil, status]);

  const buy = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api<TrialStatus | { state: "checkout"; url: string }>(PLAN_PATH, { method: "POST" });
      if (next.state === "checkout") {
        setCheckoutUntil(Date.now() + CHECKOUT_WAIT_MS);
        await openExternalLink(next.url);
      } else {
        setStatus(next);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const cancelPlan = async () => {
    if (!window.confirm(t("vm.plan.cancelConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await api<TrialStatus>(PLAN_PATH, { method: "DELETE" }));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

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

  return {
    status, busy, error, checkingOut: checkoutUntil > 0,
    start: () => void act("POST"), cancel: () => void act("DELETE"), end,
    buy: () => void buy(), cancelPlan: () => void cancelPlan(),
  };
}

export function CloudTrialOffer({ onUse, className = "mt-3" }: { onUse?: () => void; className?: string }) {
  const { status, busy, error, start, buy, checkingOut } = useCloudTrial();
  const previous = useRef(status?.state);
  useEffect(() => {
    if (previous.current === "pending" && status?.state === "active") onUse?.();
    previous.current = status?.state;
  }, [status?.state, onUse]);
  if (status?.state === "active" && onUse) {
    return (
      <div data-cloud-trial-offer="active" className={`${className} flex flex-col items-center gap-1.5`}>
        <button
          type="button"
          onClick={onUse}
          className="rounded-full bg-accent px-3.5 py-1.5 text-[12px] font-medium text-white hover:brightness-110"
        >
          {t("computer.trial.use")}
        </button>
        <span className="text-[11px] text-ink-tertiary">{trialSubtitle(status)}</span>
      </div>
    );
  }
  if (mayBuyPlan(status)) {
    return (
      <div data-cloud-trial-offer="plan" className={`${className} flex flex-col items-center gap-1.5`}>
        <button
          type="button"
          onClick={buy}
          disabled={busy || checkingOut}
          className="flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
        >
          {(busy || checkingOut) && <Loader2 size={12} className="animate-spin" />}
          {t("vm.plan.buy")}
        </button>
        <span className="text-[11px] text-ink-tertiary">{checkingOut ? t("vm.plan.checkingOut") : t("vm.plan.hint")}</span>
        {error && <p role="alert" className="text-[11px] text-danger">{error}</p>}
      </div>
    );
  }
  if (status?.state !== "offered" && status?.state !== "pending") return null;
  return (
    <div data-cloud-trial-offer={status.state} className={`${className} flex flex-col items-center gap-1.5`}>
      {status.state === "offered" ? (
        <>
          <button
            type="button"
            onClick={start}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            {t("computer.trial.try")}
          </button>
          <span className="text-[11px] text-ink-tertiary">{t("computer.trial.hint")}</span>
        </>
      ) : (
        <>
          <span className="text-[12px]">{t("vm.trial.pending")}</span>
          <button type="button" onClick={() => void openExternalLink(status.url)} className="rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-control-hover">
            {t("vm.trial.open")}
          </button>
        </>
      )}
      {error && <p role="alert" className="text-[11px] text-danger">{error}</p>}
    </div>
  );
}

export function CloudTrialRow() {
  const { status, busy, error, start, cancel, end, buy, cancelPlan, checkingOut } = useCloudTrial();
  const spinner = (busy || checkingOut) && <Loader2 size={12} className="animate-spin" />;
  const paid = onPlan(status);
  const buyButton = (
    <button type="button" onClick={buy} disabled={busy || checkingOut} className={`${pillButton} flex items-center gap-1.5`}>
      {spinner}
      {t("vm.plan.buy")}
    </button>
  );

  return (
    <>
      {status?.state === "ended" && !mayBuyPlan(status) ? (
        <p data-cloud-trial="ended" className="border-t border-hairline/40 py-4 text-[12px] text-ink-secondary">{t("vm.trial.ended")}</p>
      ) : status?.state === "ended" ? (
        <SettingRow title={t("vm.plan.title")} subtitle={checkingOut ? t("vm.plan.checkingOut") : t("vm.trial.ended")}>
          <div data-cloud-trial="ended" className="flex flex-wrap gap-2 sm:justify-end">{buyButton}</div>
        </SettingRow>
      ) : status?.state === "none" ? null : status && (
        <SettingRow title={paid ? t("vm.plan.title") : t("vm.trial.title")} subtitle={trialSubtitle(status)}>
          <div data-cloud-trial={paid ? "plan" : status.state} className="flex flex-wrap gap-2 sm:justify-end">
            {mayBuyPlan(status) && buyButton}
            {paid && "plan" in status && status.plan?.status === "active" && (
              <button type="button" onClick={cancelPlan} disabled={busy} className={`${pillButton} flex items-center gap-1.5`}>
                {busy && <Loader2 size={12} className="animate-spin" />}
                {t("vm.plan.cancel")}
              </button>
            )}
            {status.state === "offered" && (
              <button type="button" onClick={start} disabled={busy} className={`${pillButton} flex items-center gap-1.5`}>
                {spinner}
                {t("vm.trial.start")}
              </button>
            )}
            {status.state === "pending" && (
              <>
                <button type="button" onClick={() => void openExternalLink(status.url)} disabled={busy} className={pillButton}>
                  {t("vm.trial.open")}
                </button>
                <button type="button" onClick={cancel} disabled={busy} className={`${pillButton} flex items-center gap-1.5`}>
                  {spinner}
                  {t("common.cancel")}
                </button>
              </>
            )}
            {(status.state === "active" || status.state === "used_up") && !paid && (
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
