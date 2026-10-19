import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { api, useStore, type Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import { transitionComputerControlLease, type ComputerControlAction } from "@/lib/computer-control";

export const TAKEOVER_INTENT_MS = 60_000;

const controlSnapshot = z.object({
  held: z.boolean().optional().default(false),
  helpReason: z.string().nullable().optional().default(null),
}).passthrough();

const NOT_HELD = { held: false, helpReason: null } as const;

export interface ComputerHands {
  held: boolean;
  helpReason: string | null;
  opening: boolean;
  problem: string | null;
  take(): Promise<void>;
  handBack(): Promise<void>;
  skip(): Promise<void>;
}

export function useComputerHands(bot: Pick<Bot, "id" | "name" | "threadId">, awake: boolean): ComputerHands {
  const { state, dispatch } = useStore();
  const { id, name, threadId } = bot;
  const control = state.computerControl?.[id] ?? NOT_HELD;
  const [opening, setOpening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const remember = useCallback((raw: unknown) => {
    const snap = controlSnapshot.parse(raw);
    dispatch({ type: "computerControl", botId: id, held: snap.held, helpReason: snap.helpReason });
    return snap;
  }, [dispatch, id]);

  useEffect(() => {
    let current = true;
    void api(`/api/bots/${id}/computer/control`).then((raw) => { if (current) remember(raw); }).catch(() => {});
    return () => { current = false; };
  }, [id, remember]);

  useEffect(() => {
    const viewer = typeof window === "undefined" ? undefined : window.laterdog?.desktopViewer;
    if (!viewer) return;
    let current = true;
    void viewer.currentState?.().then((now) => { if (current) setViewerOpen(now.open && now.contextId === id); }).catch(() => {});
    const off = viewer.onState((now) => { if (now.contextId === id) setViewerOpen(now.open); });
    return () => {
      current = false;
      off?.();
    };
  }, [id]);

  const request = useCallback(async (action: ComputerControlAction) => remember(await api(`/api/bots/${id}/computer/control`, {
    method: "POST",
    body: JSON.stringify({ action }),
  })), [id, remember]);

  const transition = useCallback((action: ComputerControlAction) => transitionComputerControlLease({
    action,
    syncNativeBrowser: false,
    requestControl: request,
    setNativeBrowserControl: async () => true,
  }), [request]);

  const take = useCallback(async () => {
    if (opening) return;
    setOpening(true);
    setProblem(null);
    const desktop = typeof window === "undefined" ? undefined : window.laterdog;
    let fallbackTab: Window | null = null;
    if (!desktop?.desktopViewer && !desktop?.openExternal) {
      fallbackTab = window.open("", "_blank");
      if (fallbackTab) fallbackTab.opener = null;
    }
    let tookHere = false;
    try {
      if (!control.held) {
        await transition("take");
        tookHere = true;
      }
      const joined = await api<{ joinUrl?: unknown }>(`/api/bots/${id}/computer/join?threadId=${encodeURIComponent(threadId)}`, { method: "POST" });
      const url = typeof joined.joinUrl === "string" && joined.joinUrl ? joined.joinUrl : null;
      if (!url) throw new Error(t("computer.err.noDesktopLink"));
      if (desktop?.desktopViewer) {
        const opened = await desktop.desktopViewer.open(url, t("computer.viewerTitle", { name }), id, {
          label: t("takeover.inControl"),
          done: t("computer.handBack"),
        });
        if (!opened) throw new Error(t("computer.err.openDesktop"));
      } else if (fallbackTab) {
        fallbackTab.location.replace(url);
      } else if (desktop?.openExternal) {
        if (!(await desktop.openExternal(url))) throw new Error(t("computer.err.openDesktopLink"));
      } else if (!window.open(url, "_blank", "noopener")) {
        throw new Error(t("computer.err.popupBlocked"));
      }
    } catch (error) {
      fallbackTab?.close();
      if (tookHere) await transition("release").catch(() => {});
      if (alive.current) setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      if (alive.current) setOpening(false);
    }
  }, [opening, control.held, transition, id, threadId, name]);

  const handBack = useCallback(async () => {
    setProblem(null);
    await window.laterdog?.desktopViewer?.close(id).catch(() => false);
    try {
      await transition("release");
    } catch (error) {
      if (alive.current) setProblem(error instanceof Error ? error.message : String(error));
    }
  }, [id, transition]);

  const skip = useCallback(async () => {
    setProblem(null);
    try {
      await request("dismiss-help");
    } catch (error) {
      if (alive.current) setProblem(error instanceof Error ? error.message : String(error));
    }
  }, [request]);

  const viewerWasOpen = useRef(false);
  useEffect(() => {
    if (viewerWasOpen.current && !viewerOpen && control.held) void transition("release").catch(() => {});
    viewerWasOpen.current = viewerOpen;
  }, [viewerOpen, control.held, transition]);

  const intent = state.takeoverIntent?.botId === id ? state.takeoverIntent : null;
  useEffect(() => {
    if (!intent) return;
    const clear = () => dispatch({ type: "takeoverIntent", intent: null });
    const left = intent.at + TAKEOVER_INTENT_MS - Date.now();
    if (left <= 0 || viewerOpen) {
      clear();
      return;
    }
    if (!awake || !control.held || opening) {
      const timer = window.setTimeout(clear, left);
      return () => window.clearTimeout(timer);
    }
    clear();
    void take();
  }, [intent, awake, control.held, viewerOpen, opening, take, dispatch]);

  return { held: control.held, helpReason: control.helpReason, opening, problem, take, handBack, skip };
}
