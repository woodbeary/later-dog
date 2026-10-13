import { useState } from "react";
import { Loader2, LockKeyhole, Monitor } from "lucide-react";

import { isOpenTakeover, type TakeoverPlace } from "../../shared/takeover";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, useStore, type Message } from "@/state/store";

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
    dispatch({ type: "toggleComputer", open: true });
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
  const button = "flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors disabled:opacity-50";

  return (
    <section
      aria-label={t("takeover.aria", { name: botName })}
      data-takeover-card={request.status}
      className="flex w-full justify-start"
    >
      <div className="w-full max-w-[420px] overflow-hidden rounded-[18px] bg-card ring-[0.5px] ring-ink/10">
        <div className="px-3.5 pb-3 pt-3">
          <div className="flex items-center gap-2 text-[12.5px] text-ink-secondary">
            <Monitor size={14} aria-hidden="true" />
            <span className="font-medium">{t("takeover.title")}</span>
            {inControl && (
              <span className="ml-auto flex items-center gap-1.5 text-[11.5px] font-medium text-success">
                <span className="size-1.5 animate-pulse rounded-full bg-success" aria-hidden="true" />
                {t("takeover.inControl")}
              </span>
            )}
            {request.status === "done" && (
              <span className="ml-auto flex items-center gap-1.5 text-[11.5px] font-medium text-ink-secondary">
                <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
                {t("takeover.done")}
              </span>
            )}
            {request.status === "skipped" && (
              <span className="ml-auto text-[11.5px] font-medium text-ink-tertiary">{t("takeover.skipped")}</span>
            )}
          </div>
          <p className={cn("mt-1.5 text-[15px] font-medium leading-snug", open ? "text-ink" : "text-ink-secondary")}>
            {request.step}
          </p>
          {open && request.reason === "sign-in" && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-[17px] text-ink-tertiary">
              <LockKeyhole size={12} className="mt-[2px] shrink-0" aria-hidden="true" />
              {t("takeover.signInNote", { place: takeoverPlaceName(request.place, botName) })}
            </p>
          )}
          {failed && <p role="alert" className="mt-2 text-[12px] text-danger">{t("takeover.failed")}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {waiting && (
              <>
                <button type="button" onClick={() => void act("take")} disabled={busy !== null}
                  className={cn(button, "bg-ink text-app hover:opacity-90")}>
                  {spinner("take")}
                  {t("computer.takeOver")}
                </button>
                <button type="button" onClick={() => void act("done")} disabled={busy !== null}
                  className={cn(button, "text-ink ring-[0.5px] ring-ink/20 hover:bg-control")}>
                  {spinner("done")}
                  {t("computer.handBack")}
                </button>
                <button type="button" onClick={() => void act("skip")} disabled={busy !== null}
                  title={t("takeover.skipTitle", { name: botName })}
                  className={cn(button, "text-ink-secondary hover:bg-control hover:text-ink")}>
                  {spinner("skip")}
                  {t("computer.skip")}
                </button>
              </>
            )}
            {inControl && (
              <>
                <button type="button" onClick={() => showComputer(true)} disabled={busy !== null}
                  className={cn(button, "bg-ink text-app hover:opacity-90")}>
                  {t("takeover.openComputer")}
                </button>
                <button type="button" onClick={() => void act("done")} disabled={busy !== null}
                  className={cn(button, "text-ink ring-[0.5px] ring-ink/20 hover:bg-control")}>
                  {spinner("done")}
                  {t("computer.handBack")}
                </button>
              </>
            )}
            {!open && (
              <button type="button" onClick={() => showComputer(false)}
                className={cn(button, "-ml-1.5 text-ink-secondary hover:bg-control hover:text-ink")}>
                {t("takeover.openComputer")}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
