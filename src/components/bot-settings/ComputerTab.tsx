import { useEffect, useRef, useState, type ReactNode } from "react";
import { Globe, Hand, Laptop, Loader2, Monitor, MonitorOff } from "lucide-react";

import { api, useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { listenLiveFrames } from "@/lib/live-events";
import { isReadyBoatState } from "@/lib/local-computer";
import { isActiveTurnRefusal } from "@/lib/remote-desktop";
import { MacLocalControl } from "../MacLocalControl";
import { WakeDog } from "../WakeDog";
import { ScreenGoals } from "./ScreenGoals";
import { useComputerHands } from "./useComputerHands";

type Surface = "cloud" | "local" | "vm" | "browser" | "off";

export interface ComputerStatus {
  surface?: Surface;
  configured?: boolean;
  backend?: "box" | "vps";
  box?: { state?: string | null } | null;
  ready?: boolean;
  container?: "running" | "stopped" | "missing";
  problem?: string | null;
}

export type ComputerCard =
  | { kind: "checking" }
  | { kind: "asleep"; fresh: boolean; canWake: boolean }
  | { kind: "waking"; fresh: boolean; polling: boolean; held?: boolean }
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
  if (!state || SLEEPING_STATES.has(state)) {
    return { kind: "asleep", fresh: !state, canWake: bot.computer === "cloud" };
  }
  return { kind: "waking", fresh: false, polling: true };
}

const strongPill = "inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-[13px] font-medium text-panel transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-45";
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
  const { state, dispatch, flushBotPatches } = useStore();
  const [card, setCard] = useState<ComputerCard>({ kind: "checking" });
  const [round, setRound] = useState(0);
  const [frame, setFrame] = useState<string | null>(null);
  const [shotFailed, setShotFailed] = useState(false);
  const alive = useRef(true);
  const wakeNext = useRef(false);
  const wakeWhenFree = useRef(false);
  const busy = useRef(Boolean(bot.busy));
  busy.current = Boolean(bot.busy);
  const flush = useRef(flushBotPatches);
  flush.current = flushBotPatches;
  const { id, threadId, computer, autoStartVps, cloudBackend } = bot;
  const starting = state.computerStarts[id]?.state ?? null;
  const working = Boolean(bot.busy);
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
        if (controller.signal.aborted) return;
        const next = computerCardFor({ computer, autoStartVps }, status);
        const turnedOn = wakeNext.current;
        wakeNext.current = false;
        if (turnedOn && next.kind === "asleep" && next.canWake) {
          void wake(next.fresh);
          return;
        }
        if (wakeWhenFree.current && next.kind === "asleep" && next.canWake) {
          if (busy.current) {
            setCard({ kind: "waking", fresh: next.fresh, polling: true, held: true });
            return;
          }
          wakeWhenFree.current = false;
          void wake(next.fresh);
          return;
        }
        wakeWhenFree.current = false;
        setCard(starting && next.kind === "asleep" ? { kind: "waking", fresh: next.fresh, polling: true } : next);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        wakeNext.current = false;
        setCard({ kind: "unreachable" });
      });
    return () => controller.abort();
  }, [id, query, computer, autoStartVps, cloudBackend, round, starting, working]);

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
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [awake, id, threadId, query, round]);

  useEffect(() => listenLiveFrames({
    onFrame: (live) => {
      if (live.kind !== "screen" || live.botId !== id || live.threadId !== threadId) return;
      setFrame(`data:${live.mime ?? "image/png"};base64,${live.png}`);
      setShotFailed(false);
      setCard((current) => current.kind === "awake" ? current : { kind: "awake" });
    },
  }), [id, threadId]);

  const hands = useComputerHands(bot, card.kind === "awake");
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
        wakeWhenFree.current = true;
        setCard({ kind: "waking", fresh, polling: true, held: true });
        return;
      }
      setCard({ kind: "wakeFailed", fresh, problem: error instanceof Error ? error.message : String(error) });
    }
  };
  const turnOn = () => {
    wakeNext.current = true;
    setCard({ kind: "waking", fresh: true, polling: false });
    dispatch({ type: "updateBot", botId: id, patch: { computer: "cloud" } });
    setRound((value) => value + 1);
  };

  const dog = { color: bot.color, bodyId: bot.mascotBody ?? undefined };
  const wakeLabel = t("computer.wakeDog", { name: bot.name });

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
          <WakeDog {...dog} label={wakeLabel} hint={t("computer.wakeHint")} onWake={card.canWake ? () => void wake(card.fresh) : turnOn}>
            <div className={headline}>{t("botSettings.computer.asleep")}</div>
          </WakeDog>
        </Middle>
      );
      break;
    case "waking":
      body = (
        <Middle status>
          <WakeDog
            {...dog}
            busy
            label={wakeLabel}
            hint={card.held ? t("botSettings.computer.wakeWhenFree", { name: bot.name }) : card.fresh ? t("botSettings.computer.firstStart") : undefined}
            onWake={() => void wake(card.fresh)}
          >
            <div className={headline}>{t("botSettings.computer.waking")}</div>
          </WakeDog>
        </Middle>
      );
      break;
    case "awake":
      body = shotFailed && !frame ? (
        <Middle>
          <Monitor size={22} className="text-ink-secondary" aria-hidden="true" />
          <div className={headline}>{t("botSettings.computer.unreachable", { name: bot.name })}</div>
          <button type="button" data-computer-retry onClick={retry} className={pill}>{t("botSettings.computer.tryAgain")}</button>
        </Middle>
      ) : (
        <div data-computer-screen className="absolute inset-0 flex items-center justify-center">
          {frame ? (
            <img src={frame} alt={t("computer.screenOf", { name: bot.name })} className="h-full w-full object-contain" />
          ) : (
            <Loader2 size={18} className="animate-spin text-ink-secondary" aria-hidden="true" />
          )}
        </div>
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
          <WakeDog {...dog} label={wakeLabel} hint={t("computer.retryHint")} onWake={() => void wake(card.fresh)}>
            <div role="alert" className="flex flex-col items-center gap-1">
              <div className={headline}>{t("botSettings.computer.wakeFailed", { name: bot.name })}</div>
              {card.problem && <p className={cn(line, "line-clamp-3")}>{card.problem}</p>}
            </div>
          </WakeDog>
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
        </Middle>
      );
      break;
    case "off":
      body = (
        <Middle>
          <WakeDog {...dog} label={t("computer.turnOn", { name: bot.name })} hint={t("computer.turnOnHint")} onWake={turnOn}>
            <div className={headline}>{t("botSettings.computer.noScreen")}</div>
            <p className={line}>{t("place.view.off.line", { bot: bot.name })}</p>
          </WakeDog>
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
      {card.kind === "awake" && (
        <div className="mt-3 flex flex-col items-center gap-3" data-computer-hands={hands.held ? "held" : "watching"}>
          {hands.held ? (
            <div className="flex w-full items-center gap-3 rounded-xl bg-card px-4 py-3">
              <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink">{t("computer.youHaveWheel", { name: bot.name })}</span>
              <button type="button" onClick={() => void hands.handBack()} className={pill}>{t("computer.handBack")}</button>
            </div>
          ) : hands.helpReason ? (
            <div role="status" className="w-full rounded-xl bg-card px-4 py-3">
              <p className="text-[13px] leading-relaxed text-ink">
                <b className="font-medium">{t("computer.needsYou", { name: bot.name })}</b> {hands.helpReason}
              </p>
              <div className="mt-2.5 flex gap-2">
                <button type="button" onClick={() => void hands.take()} disabled={hands.opening} className={strongPill}>
                  {hands.opening ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Hand size={13} aria-hidden="true" />}
                  {t("computer.takeControl")}
                </button>
                <button type="button" onClick={() => void hands.skip()} disabled={hands.opening} className={pill}>{t("computer.skip")}</button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => void hands.take()} disabled={hands.opening} className={strongPill}>
              {hands.opening && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
              {t("computer.takeControl")}
            </button>
          )}
          {hands.problem && <p role="alert" className={cn(line, "text-center text-danger")}>{hands.problem}</p>}
        </div>
      )}
      {card.kind === "elsewhere" && card.surface === "local" && <MacLocalControl />}
      <ScreenGoals bot={bot} />
    </div>
  );
}
