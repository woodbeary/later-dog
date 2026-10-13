import { useEffect, useRef, useState, type ReactNode } from "react";
import { Globe, Laptop, Loader2, Maximize2, Monitor, MonitorOff } from "lucide-react";

import { api, useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { listenLiveFrames } from "@/lib/live-events";
import { isReadyBoatState } from "@/lib/local-computer";
import { isActiveTurnRefusal } from "@/lib/remote-desktop";
import { SleepingDog } from "../AccountCharge";
import { DogAvatar } from "../Avatar";

type Surface = "cloud" | "local" | "vm" | "browser" | "off";

export interface ComputerStatus {
  surface?: Surface;
  configured?: boolean;
  backend?: "box" | "vps";
  teamComputer?: { id: string; name: string };
  box?: { state?: string | null } | null;
  ready?: boolean;
  container?: "running" | "stopped" | "missing";
  problem?: string | null;
}

export type ComputerCard =
  | { kind: "checking" }
  | { kind: "asleep"; fresh: boolean; canWake: boolean; team?: string }
  | { kind: "waking"; fresh: boolean; polling: boolean }
  | { kind: "awake" }
  | { kind: "unreachable" }
  | { kind: "wakeFailed"; fresh: boolean; problem: string }
  | { kind: "elsewhere"; surface: "local" | "vm" | "browser" }
  | { kind: "unset" }
  | { kind: "off" };

const SLEEPING_STATES = new Set(["archived", "stopped"]);
const WAKING_POLL_MS = 3000;
const IDLE_SHOT_MS = 30_000;
const BUSY_SHOT_MS = 5000;

export function computerCardFor(bot: Pick<Bot, "computer" | "autoStartVps">, status: ComputerStatus): ComputerCard {
  const surface = status.surface ?? "cloud";
  if (surface === "off") return { kind: "off" };
  if (surface !== "cloud") return { kind: "elsewhere", surface };
  if (status.configured === false) return { kind: "unset" };
  if (status.backend === "vps") {
    if (status.ready) return { kind: "awake" };
    return { kind: "asleep", fresh: status.container === "missing", canWake: bot.computer === "cloud" || bot.autoStartVps === true };
  }
  const state = status.box?.state ?? null;
  if (isReadyBoatState(state)) return { kind: "awake" };
  const team = status.teamComputer?.name;
  if (!state || SLEEPING_STATES.has(state)) {
    return { kind: "asleep", fresh: !state, canWake: !team && bot.computer === "cloud", ...(team ? { team } : {}) };
  }
  return { kind: "waking", fresh: false, polling: true };
}

const pill = "rounded-full bg-control px-4 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-control-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-45";
const headline = "text-[14px] font-medium text-ink";
const line = "max-w-[17rem] text-[12px] leading-relaxed text-ink-secondary";

function Middle({ children, status = false }: { children: ReactNode; status?: boolean }) {
  return (
    <div role={status ? "status" : undefined} className="flex flex-col items-center gap-2.5 px-6 text-center">
      {children}
    </div>
  );
}

export function ComputerTab({ bot }: { bot: Bot }) {
  const { dispatch, flushBotPatches } = useStore();
  const [card, setCard] = useState<ComputerCard>({ kind: "checking" });
  const [round, setRound] = useState(0);
  const [frame, setFrame] = useState<string | null>(null);
  const [shotFailed, setShotFailed] = useState(false);
  const alive = useRef(true);
  const busy = useRef(Boolean(bot.busy));
  busy.current = Boolean(bot.busy);
  const flush = useRef(flushBotPatches);
  flush.current = flushBotPatches;
  const { id, threadId, computer, autoStartVps, cloudBackend } = bot;
  const query = `?threadId=${encodeURIComponent(threadId)}`;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve(flush.current(id))
      .catch(() => null)
      .then(() => api<ComputerStatus>(`/api/bots/${id}/computer${query}`, { signal: controller.signal }))
      .then((status) => {
        if (!controller.signal.aborted) setCard(computerCardFor({ computer, autoStartVps }, status));
      })
      .catch(() => {
        if (!controller.signal.aborted) setCard({ kind: "unreachable" });
      });
    return () => controller.abort();
  }, [id, query, computer, autoStartVps, cloudBackend, round]);

  const polling = card.kind === "waking" && card.polling;
  useEffect(() => {
    if (!polling) return;
    const timer = setTimeout(() => setRound((value) => value + 1), WAKING_POLL_MS);
    return () => clearTimeout(timer);
  }, [polling, round]);

  const awake = card.kind === "awake";
  useEffect(() => {
    if (!awake) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seen = false;
    setShotFailed(false);
    const shoot = async () => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        try {
          const { png, format } = await api<{ png?: unknown; format?: unknown }>(`/api/bots/${id}/computer/screenshot${query}`, {
            method: "POST",
            signal: controller.signal,
            timeoutMs: 90_000,
          });
          if (controller.signal.aborted) return;
          if (typeof png === "string" && png.trim()) {
            seen = true;
            setFrame(`data:${format === "jpeg" ? "image/jpeg" : "image/png"};base64,${png}`);
            setShotFailed(false);
          } else if (!seen) {
            setShotFailed(true);
          }
        } catch {
          if (controller.signal.aborted) return;
          if (!seen) setShotFailed(true);
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void shoot(), busy.current ? BUSY_SHOT_MS : IDLE_SHOT_MS);
    };
    void shoot();
    const stop = listenLiveFrames({
      onFrame: (live) => {
        if (live.kind !== "screen" || live.botId !== id || live.threadId !== threadId) return;
        seen = true;
        setFrame(`data:${live.mime ?? "image/png"};base64,${live.png}`);
        setShotFailed(false);
      },
    });
    return () => {
      controller.abort();
      clearTimeout(timer);
      stop();
    };
  }, [awake, id, threadId, query, round]);

  const open = () => dispatch({ type: "toggleComputer", open: true });
  const retry = () => {
    setFrame(null);
    setCard({ kind: "checking" });
    setRound((value) => value + 1);
  };
  const wake = async (fresh: boolean) => {
    setCard({ kind: "waking", fresh, polling: false });
    try {
      const result = await api<{ ready?: boolean; problem?: string | null }>(`/api/bots/${id}/computer/provision`, { method: "POST" });
      if (!alive.current) return;
      if (result.ready === false) {
        setCard({ kind: "wakeFailed", fresh, problem: result.problem ?? "" });
        return;
      }
      setRound((value) => value + 1);
    } catch (error) {
      if (!alive.current) return;
      if (isActiveTurnRefusal(error)) {
        setCard({ kind: "waking", fresh, polling: true });
        return;
      }
      setCard({ kind: "wakeFailed", fresh, problem: error instanceof Error ? error.message : String(error) });
    }
  };

  const openButton = (
    <button type="button" data-computer-open onClick={open} className={pill}>{t("computer.open")}</button>
  );
  const dog = { color: bot.color, bodyId: bot.mascotBody ?? undefined };

  let body: ReactNode;
  switch (card.kind) {
    case "checking":
      body = (
        <Middle status>
          <Loader2 size={18} className="animate-spin text-ink-secondary" aria-hidden="true" />
          <span className="sr-only">{t("botSettings.computer.checking")}</span>
        </Middle>
      );
      break;
    case "asleep":
      body = (
        <Middle>
          <SleepingDog size={76} color={dog.color} bodyId={dog.bodyId} className="mb-1" />
          <div className={headline}>{t("botSettings.computer.asleep")}</div>
          {card.team && <p className={line}>{t("place.view.autoTeam.line", { computer: card.team })}</p>}
          {card.canWake ? (
            <button type="button" data-computer-wake onClick={() => void wake(card.fresh)} className={pill}>
              {t("botSettings.computer.wake")}
            </button>
          ) : openButton}
        </Middle>
      );
      break;
    case "waking":
      body = (
        <Middle status>
          <DogAvatar color={dog.color} bodyId={dog.bodyId} state="waking" size={76} trackPointer={false} />
          <div className={cn(headline, "flex items-center gap-1.5")}>
            <Loader2 size={14} className="animate-spin text-ink-secondary" aria-hidden="true" />
            {t("botSettings.computer.waking")}
          </div>
          {card.fresh && <p className={line}>{t("botSettings.computer.firstStart")}</p>}
        </Middle>
      );
      break;
    case "awake":
      body = shotFailed && !frame ? (
        <Middle>
          <Monitor size={22} className="text-ink-secondary" aria-hidden="true" />
          <div className={headline}>{t("botSettings.computer.unreachable", { name: bot.name })}</div>
          <div className="flex gap-2">
            <button type="button" data-computer-retry onClick={retry} className={pill}>{t("botSettings.computer.tryAgain")}</button>
            {openButton}
          </div>
        </Middle>
      ) : (
        <button
          type="button"
          data-computer-open
          onClick={open}
          aria-label={t("computer.openLiveDesktopAria", { name: bot.name })}
          className="group absolute inset-0 flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
        >
          {frame ? (
            <img
              src={frame}
              alt={t("computer.screenOf", { name: bot.name })}
              className="h-full w-full object-contain transition-[filter] duration-300 group-hover:brightness-75"
            />
          ) : (
            <Loader2 size={18} className="animate-spin text-ink-secondary" aria-hidden="true" />
          )}
          <span className="pointer-events-none absolute bottom-2.5 right-2.5 flex items-center gap-1.5 rounded-full bg-black/75 px-3 py-1 text-[12px] font-medium text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100">
            <Maximize2 size={12} aria-hidden="true" />
            {t("computer.open")}
          </span>
        </button>
      );
      break;
    case "unreachable":
      body = (
        <Middle>
          <Monitor size={22} className="text-ink-secondary" aria-hidden="true" />
          <div className={headline}>{t("botSettings.computer.unreachable", { name: bot.name })}</div>
          <button type="button" data-computer-retry onClick={retry} className={pill}>{t("botSettings.computer.tryAgain")}</button>
        </Middle>
      );
      break;
    case "wakeFailed":
      body = (
        <Middle>
          <SleepingDog size={56} color={dog.color} bodyId={dog.bodyId} />
          <div role="alert" className="flex flex-col items-center gap-1">
            <div className={headline}>{t("botSettings.computer.wakeFailed", { name: bot.name })}</div>
            {card.problem && <p className={cn(line, "line-clamp-3")}>{card.problem}</p>}
          </div>
          <button type="button" data-computer-wake onClick={() => void wake(card.fresh)} className={pill}>
            {t("botSettings.computer.tryAgain")}
          </button>
        </Middle>
      );
      break;
    case "elsewhere": {
      const Icon = card.surface === "local" ? Laptop : card.surface === "browser" ? Globe : Monitor;
      body = (
        <Middle>
          <Icon size={26} className="text-ink-secondary" aria-hidden="true" />
          <div className={headline}>
            {card.surface === "local"
              ? t("botSettings.computer.thisDevice")
              : t(card.surface === "browser" ? "place.view.browser.short" : "place.view.vm.short")}
          </div>
          <p className={line}>{t(`place.view.${card.surface}.line`)}</p>
          {openButton}
        </Middle>
      );
      break;
    }
    case "unset":
      body = (
        <Middle>
          <MonitorOff size={24} className="text-ink-secondary" aria-hidden="true" />
          <div className={headline}>{t("botSettings.computer.noScreen")}</div>
          <p className={line}>{t("place.view.ccNeedsKey.line")}</p>
          {openButton}
        </Middle>
      );
      break;
    case "off":
      body = (
        <Middle>
          <MonitorOff size={24} className="text-ink-secondary" aria-hidden="true" />
          <div className={headline}>{t("botSettings.computer.noScreen")}</div>
          <p className={line}>{t("place.view.off.line", { bot: bot.name })}</p>
          <button
            type="button"
            data-computer-turn-on
            onClick={() => dispatch({ type: "updateBot", botId: id, patch: { computer: "cloud" } })}
            className={pill}
          >
            {t("computer.turnOn", { name: bot.name })}
          </button>
        </Middle>
      );
      break;
  }

  return (
    <div role="tabpanel" className="mt-5" data-simple-computer={card.kind}>
      <div className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-card">
        {body}
      </div>
      <p className="mt-2 text-center text-[12px] text-ink-tertiary">{t("computer.screenOf", { name: bot.name })}</p>
    </div>
  );
}
