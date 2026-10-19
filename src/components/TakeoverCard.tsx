import { useState } from "react";
import { Check, Loader2, LockKeyhole, Monitor } from "lucide-react";

import { isOpenTakeover, type TakeoverPlace } from "../../shared/takeover";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, useStore, type Message } from "@/state/store";
import { REQUEST_PRIMARY, REQUEST_QUIET, REQUEST_SECONDARY, RequestCard, RequestStatus } from "./RequestCard";

type TakeoverAction = "take" | "done" | "skip";

export function takeoverPlaceName(place: TakeoverPlace | undefined, name: string): string {
  switch (place) {
    case "cloud":
      return t("takeover.place.cloud", { name });
    case "vm":
      return t("takeover.place.vm", { name });
    case "local":
      return t("takeover.place.local");
    case "browser":
      return t("takeover.place.browser", { name });
    default:
      return t("takeover.place.other", { name });
  }
}

export function TakeoverCard({
  botId,
  botName,
  threadId,
  message,
}: {
  botId: string;
  botName: string;
  threadId: string;
  message: Message;
}) {
  const { state, dispatch } = useStore();
  const request = message.card!.takeoverRequest!;
  const [busy, setBusy] = useState<TakeoverAction | null>(null);
  const [failed, setFailed] = useState(false);
  const open = isOpenTakeover(request.status);
  const waiting = request.status === "waiting";
  const inControl = request.status === "in-control";

  const showComputer = (handOver: boolean) => {
    if (state.selectedId !== botId) dispatch({ type: "select", id: botId });
    dispatch({ type: "takeoverIntent", intent: handOver ? { botId, at: Date.now() } : null });
    dispatch({ type: "toggleSettings", open: true, section: "access" });
  };

  const act = async (action: TakeoverAction) => {
    if (busy) return;
    setBusy(action);
    setFailed(false);
    try {
      await api(`/api/bots/${encodeURIComponent(botId)}/takeover-cards/${encodeURIComponent(message.id)}/${action}`, {
        method: "POST",
        body: JSON.stringify({ threadId }),
      });
      if (action === "take") showComputer(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  const spinner = (action: TakeoverAction) => busy === action && <Loader2 size={13} className="animate-spin" aria-hidden="true" />;

  const status = inControl
    ? <RequestStatus tone="live">{t("takeover.inControl")}</RequestStatus>
    : request.status === "done"
      ? <RequestStatus tone="success" leading={<Check size={12} aria-hidden="true" />}>{t("takeover.done")}</RequestStatus>
      : request.status === "skipped"
        ? <RequestStatus tone="muted">{t("takeover.skipped")}</RequestStatus>
        : null;

  return (
    <RequestCard
      label={t("takeover.aria", { name: botName })}
      data={{ "data-takeover-card": request.status }}
      media={<Monitor size={17} aria-hidden="true" />}
      title={request.step}
      subtitle={takeoverPlaceName(request.place, botName)}
      active={open}
      trailing={waiting ? (
        <button type="button" onClick={() => void act("take")} disabled={busy !== null} className={REQUEST_PRIMARY}>
          {spinner("take")}
          {t("computer.takeOver")}
        </button>
      ) : status}
    >
      <div className="px-3.5 pb-3">
        {open && request.reason === "sign-in" && (
          <p className="flex items-start gap-1.5 text-[12px] leading-[17px] text-ink-tertiary">
            <LockKeyhole size={12} className="mt-[2px] shrink-0" aria-hidden="true" />
            {t("takeover.signInNote", { place: takeoverPlaceName(request.place, botName) })}
          </p>
        )}
        {failed && <p role="alert" className="mt-2 text-[12px] text-danger">{t("takeover.failed")}</p>}
        <div className={cn("flex flex-wrap items-center gap-2", (open && request.reason === "sign-in") || failed ? "mt-2.5" : "")}>
          {waiting && (
            <>
              <button type="button" onClick={() => void act("done")} disabled={busy !== null} className={REQUEST_SECONDARY}>
                {spinner("done")}
                {t("computer.handBack")}
              </button>
              <button type="button" onClick={() => void act("skip")} disabled={busy !== null}
                title={t("takeover.skipTitle", { name: botName })} className={REQUEST_QUIET}>
                {spinner("skip")}
                {t("computer.skip")}
              </button>
            </>
          )}
          {inControl && (
            <>
              <button type="button" onClick={() => showComputer(true)} disabled={busy !== null} className={REQUEST_PRIMARY}>
                {t("takeover.openComputer")}
              </button>
              <button type="button" onClick={() => void act("done")} disabled={busy !== null} className={REQUEST_SECONDARY}>
                {spinner("done")}
                {t("computer.handBack")}
              </button>
            </>
          )}
          {!open && (
            <button type="button" onClick={() => showComputer(false)} className={cn(REQUEST_QUIET, "-ml-1.5")}>
              {t("takeover.openComputer")}
            </button>
          )}
        </div>
      </div>
    </RequestCard>
  );
}
