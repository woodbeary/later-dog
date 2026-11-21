import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, KeyRound, Loader2, RotateCw } from "lucide-react";

import {
  deviceApprovalActionPath,
  shownDeviceApprovalStatus,
  type DeviceApprovalAction,
  type DeviceApprovalCardData,
} from "../../shared/device-approval";
import { openExternalLink } from "@/lib/app-links";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { api, type Message } from "@/state/store";
import { REQUEST_PRIMARY, REQUEST_QUIET, REQUEST_SECONDARY, RequestCard, RequestStatus } from "./RequestCard";

export function deviceApprovalRenewable(card: Pick<DeviceApprovalCardData, "status" | "renew">): boolean {
  return card.status === "expired" && card.renew === "offered";
}

export function deviceApprovalCountdown(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function deviceApprovalSettledWords(card: Pick<DeviceApprovalCardData, "status" | "expiresAt" | "endedBy" | "renew">, now: number): string | null {
  const status = shownDeviceApprovalStatus(card, now);
  if (status === "waiting") return null;
  if (status === "ended" && card.endedBy === "replaced") return t("deviceApproval.state.replaced");
  if (status === "ended" && card.endedBy === "dismissed") return t("deviceApproval.state.dismissed");
  if (status === "expired" && card.renew === "asked") return t("deviceApproval.state.renewing");
  return t(`deviceApproval.state.${status}`);
}

function useSecondClock(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

export function DeviceApprovalCard({ botId, threadId, message }: { botId: string; threadId: string; message: Message }) {
  const card = message.card!.deviceApproval!;
  const now = useSecondClock(card.status === "waiting");
  const [sending, setSending] = useState<DeviceApprovalAction | null>(null);
  const [failed, setFailed] = useState(false);
  const { state: copied, copy } = useCopyFeedback(card.code ?? "");
  const status = shownDeviceApprovalStatus(card, now);
  const waiting = status === "waiting";
  const renewable = deviceApprovalRenewable(card);
  const renewing = card.status === "expired" && card.renew === "asked";
  const settled = deviceApprovalSettledWords(card, now);

  const act = async (action: DeviceApprovalAction) => {
    if (sending) return;
    setSending(action);
    setFailed(false);
    try {
      await api(deviceApprovalActionPath(botId, message.id, action), { method: "POST", body: JSON.stringify({ threadId }) });
    } catch {
      setFailed(true);
    } finally {
      setSending(null);
    }
  };

  const spinner = (action: DeviceApprovalAction) => sending === action && <Loader2 size={13} className="animate-spin" aria-hidden="true" />;

  const trailing = waiting
    ? <RequestStatus tone="live">{t("deviceApproval.left", { time: deviceApprovalCountdown(card.expiresAt, now) })}</RequestStatus>
    : status === "approved"
      ? <RequestStatus tone="success" leading={<Check size={12} aria-hidden="true" />}>{settled}</RequestStatus>
      : <RequestStatus tone="muted">{settled}</RequestStatus>;

  return (
    <RequestCard
      label={t("deviceApproval.aria", { service: card.service })}
      data={{ "data-device-approval": renewing ? "renewing" : status }}
      media={<KeyRound size={17} aria-hidden="true" />}
      title={t("deviceApproval.title", { service: card.service })}
      subtitle={card.service}
      active={waiting || renewable}
      trailing={trailing}
    >
      {(waiting || renewable || failed) && (
        <div className="px-3.5 pb-3">
          {waiting && <p className="text-[12px] leading-[17px] text-ink-secondary">{t(card.code ? "deviceApproval.steps.code" : "deviceApproval.steps.noCode")}</p>}
          {renewable && <p className="text-[12px] leading-[17px] text-ink-secondary">{t("deviceApproval.renewHint")}</p>}
          {waiting && card.code && (
            <div className="mt-2.5 flex items-center gap-2 rounded-xl bg-control py-1.5 pl-3 pr-1.5">
              <span data-device-code className="min-w-0 flex-1 select-all truncate font-mono text-[22px] font-semibold tabular-nums tracking-[0.12em] text-ink">{card.code}</span>
              <button type="button" onClick={copy} className={REQUEST_QUIET}>
                {copied === "copied" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                {t(copied === "copied" ? "deviceApproval.copied" : copied === "failed" ? "common.copyFailed" : "deviceApproval.copy")}
              </button>
            </div>
          )}
          {failed && <p role="alert" className="mt-2 text-[12px] text-danger">{t("deviceApproval.failed")}</p>}
          {(waiting || renewable) && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {waiting && (
                <>
                  <button type="button" onClick={() => void openExternalLink(card.url)} className={REQUEST_PRIMARY}>
                    <ExternalLink size={13} aria-hidden="true" />
                    {t("deviceApproval.open")}
                  </button>
                  <button type="button" onClick={() => void act("done")} disabled={sending !== null} className={REQUEST_SECONDARY}>
                    {spinner("done")}
                    {t("deviceApproval.approved")}
                  </button>
                  <button type="button" onClick={() => void act("dismiss")} disabled={sending !== null} className={REQUEST_QUIET}>
                    {spinner("dismiss")}
                    {t("deviceApproval.dismiss")}
                  </button>
                </>
              )}
              {renewable && (
                <button type="button" onClick={() => void act("renew")} disabled={sending !== null} className={REQUEST_PRIMARY}>
                  {sending === "renew" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <RotateCw size={13} aria-hidden="true" />}
                  {t("deviceApproval.renew")}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </RequestCard>
  );
}
