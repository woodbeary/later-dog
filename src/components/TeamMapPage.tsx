import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Box, Monitor, Network, Plus, Users, X } from "lucide-react";

import { api, formatTime, useStore, type Bot } from "@/state/store";
import {
  EMPTY_TEAM_MAP_SNAPSHOT,
  buildTeamMapEdges,
  buildTeamMapSections,
  teamMapBotCount,
  type TeamMapEdge,
  type TeamMapSnapshot,
} from "@/lib/team-map";
import { cn } from "@/lib/cn";
import { TeamCanvas } from "./TeamCanvas";
import { TeamDialog } from "./TeamDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { t } from "@/lib/i18n";
import { CanvasComputers } from "./CanvasComputers";
import type { TeamComputer } from "../../shared/team-computer";

function EdgeRow({ edge, bots }: { edge: TeamMapEdge; bots: Bot[] }) {
  const { dispatch } = useStore();
  const source = bots.find((bot) => bot.id === edge.sourceBotId);
  const target = bots.find((bot) => bot.id === edge.targetBotId);
  if (!source || !target) return null;
  const live = edge.state !== "connected";
  return (
    <button
      onClick={() => dispatch({ type: "select", id: edge.groupId ?? target.id })}
      className="flex w-full items-center gap-3 rounded-xl border border-hairline/40 bg-card px-3 py-2.5 text-left transition hover:bg-raised/50"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-[13px] font-medium text-ink">{source.name}</span>
        <ArrowRight size={13} className={cn("shrink-0", live ? "text-accent" : "text-ink-secondary")} />
        <span className="truncate text-[13px] font-medium text-ink">{target.name}</span>
      </div>
      {edge.reason && <span className="max-w-[220px] truncate text-[11.5px] text-ink-secondary">{edge.reason}</span>}
      <span
        className={cn(
          "rounded-full px-2 py-0.5 text-[10.5px] font-medium",
          edge.state === "running"
            ? "bg-success/15 text-success"
            : edge.state === "queued"
              ? "bg-warning/15 text-warning"
              : "bg-control text-ink-secondary",
        )}
      >
        {edge.state === "running" ? "Running" : edge.state === "queued" ? "Queued" : edge.lastAt ? formatTime(edge.lastAt) : "Connected"}
      </span>
    </button>
  );
}

export function TeamMapPage() {
  const { state, dispatch } = useStore();
  const [snapshot, setSnapshot] = useState<TeamMapSnapshot>(EMPTY_TEAM_MAP_SNAPSHOT);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [teamEditor, setTeamEditor] = useState<{ section?: string; rename?: boolean } | null>(null);
  const [deletingTeam, setDeletingTeam] = useState<string | null>(null);
  const [computersOpen, setComputersOpen] = useState(false);
  const [createComputerRequest, setCreateComputerRequest] = useState(0);
  const [computers, setComputers] = useState<TeamComputer[]>([]);
  const [computerDrop, setComputerDrop] = useState<{ id: string; section: string } | null>(null);
  const clearComputerDrop = useCallback(() => setComputerDrop(null), []);
  const [pendingMove, setPendingMove] = useState<{ bot: Bot; destination: string; resolve: (moved: boolean) => void } | null>(null);
  const pendingMoveRef = useRef(pendingMove);
  pendingMoveRef.current = pendingMove;
  useEffect(() => () => pendingMoveRef.current?.resolve(false), []);
  const bots = useMemo(() => state.bots.filter((bot) => !bot.hidden), [state.bots]);
  const sections = useMemo(() => {
    const names = [...new Set([...(state.sections ?? []), ...state.groups.flatMap((group) => group.section ? [group.section] : [])])];
    const order = (key: string) => key === "" ? -1 : names.includes(key) ? names.indexOf(key) : names.length;
    return buildTeamMapSections(bots, names).sort((a, b) => order(a.key) - order(b.key));
  }, [bots, state.sections, state.groups]);
  const edges = useMemo(() => buildTeamMapEdges(bots, snapshot), [bots, snapshot]);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await api("/api/team-map"));
      setRefreshError(null);
    } catch (requestError) {
      setRefreshError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const moveBot = async (bot: Bot, destination: string) => {
    setError(null);
    try {
      const result: { sections: string[]; bots: Bot[] } = await api("/api/sidebar-sections", {
        method: "POST", body: JSON.stringify({ name: destination, botIds: [bot.id] }),
      });
      dispatch({ type: "sections", sections: result.sections });
      for (const patched of result.bots) dispatch({ type: "botPatched", bot: patched });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  };

  const requestMove = (bot: Bot, destination: string) => new Promise<boolean>((resolve) => {
    pendingMoveRef.current?.resolve(false);
    setPendingMove({ bot, destination, resolve });
  });
  const cancelMove = useCallback(() => {
    pendingMoveRef.current?.resolve(false);
    setPendingMove(null);
  }, []);

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-hairline/40 px-6 py-4 max-md:pl-12">
        <div>
          <div className="flex items-center gap-2.5">
            <Network size={18} className="text-ink-secondary" />
            <h1 className="text-[17px] font-semibold">Pack map</h1>
            <span className="ml-1 text-[11px] text-ink-secondary">{teamMapBotCount(bots.length)}</span>
          </div>
          <p className="mt-1 text-[12px] text-ink-secondary">{t("canvas.description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setComputersOpen((value) => !value)} aria-label="Computers" aria-expanded={computersOpen} className="rounded-lg p-2 text-ink-secondary hover:bg-control hover:text-ink"><Monitor size={17} /></button>
          <details className="relative" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.removeAttribute("open"); }} onKeyDown={(event) => {
            if (event.key === "Escape") { event.currentTarget.removeAttribute("open"); event.currentTarget.querySelector("summary")?.focus(); }
          }}>
            <summary aria-label="Add to pack map" className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg border border-hairline/60 bg-panel px-3 py-2 text-[12px] font-medium hover:bg-control [&::-webkit-details-marker]:hidden"><Plus size={14} /> Add</summary>
            <div className="absolute right-0 top-full z-40 mt-2 w-52 rounded-xl border border-hairline/60 bg-panel p-1.5 shadow-xl" onClick={(event) => {
              const details = event.currentTarget.closest("details"); details?.querySelector("summary")?.focus(); details?.removeAttribute("open");
            }}>
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-[12px] hover:bg-control" onClick={() => setTeamEditor({})}><Users size={14} />{t("team.create")}</button>
              <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-[12px] hover:bg-control" onClick={() => { setComputersOpen(true); setCreateComputerRequest((value) => value + 1); }}><Box size={14} />Cloud computer</button>
            </div>
          </details>
        </div>
      </header>
      {(error || refreshError) && <div role="alert" className="flex shrink-0 items-center justify-between gap-3 border-b border-danger/20 bg-danger/10 px-6 py-2 text-[12px] text-danger">
        {error || refreshError}
        <button aria-label={t("common.close")} className="rounded p-1 hover:bg-danger/10" onClick={() => { setError(null); setRefreshError(null); }}><X size={14} /></button>
      </div>}
      <div className="relative flex min-h-0 flex-1">
      <TeamCanvas sections={sections} canManage onMove={requestMove}
        connectedBotIds={state.settingsOpen ? edges.flatMap((edge) => edge.sourceBotId === state.selectedId ? [edge.targetBotId] : edge.targetBotId === state.selectedId ? [edge.sourceBotId] : []) : []}
        onComputer={(bot) => dispatch({ type: "toggleSettings", botId: bot.id, section: "access", open: true })}
        teamComputers={Object.fromEntries(computers.filter((computer) => computer.section !== null).map((computer) => [computer.section!, { name: computer.name, state: computer.state }]))}
        onTeamComputer={() => setComputersOpen(true)}
        onComputerDrop={(id, section) => { setComputersOpen(true); setComputerDrop({ id, section }); }}
        onEditTeam={(section, rename) => setTeamEditor({ section, rename })}
        onDeleteTeam={setDeletingTeam}
        isEmpty={(key) => ![...state.bots, ...state.groups].some((record) => record.section?.trim() === key)} />
      <CanvasComputers open={computersOpen} createRequest={createComputerRequest} drop={computerDrop} sections={sections}
        onClose={() => setComputersOpen(false)} onDropHandled={clearComputerDrop} onChange={setComputers} />
      </div>
      {edges.length > 0 && <details className="shrink-0 border-t border-hairline/40 bg-panel px-6 py-3">
        <summary className="cursor-pointer text-[12px] text-ink-secondary">{t("canvas.handoffs")} · {edges.length}</summary>
        <div className="mt-3 max-h-48 space-y-2 overflow-y-auto">{edges.slice(0, 12).map((edge) => <EdgeRow key={`${edge.sourceBotId}:${edge.targetBotId}`} edge={edge} bots={bots} />)}</div>
      </details>}
      {teamEditor && <TeamDialog {...teamEditor} onClose={() => setTeamEditor(null)} />}
      <ConfirmDialog open={pendingMove !== null} tone="neutral" title={`Move ${pendingMove?.bot.name ?? "dog"} to ${pendingMove?.destination || "General"}?`}
        body="This changes the dog's home pack, not just its position. Its conversations and model stay with it. To arrange visually, drag within the same pack."
        confirmLabel="Move dog" onCancel={cancelMove} onConfirm={() => {
          const move = pendingMoveRef.current;
          if (!move) return;
          setPendingMove(null);
          void moveBot(move.bot, move.destination).then(() => move.resolve(true), () => move.resolve(false));
        }} />
      <ConfirmDialog open={deletingTeam !== null} title={t("team.deleteTitle", { name: deletingTeam ?? "" })}
        body={t("team.deleteKeepBotsDescription")}
        confirmLabel={t("team.delete")} onCancel={() => setDeletingTeam(null)} onConfirm={() => {
          const name = deletingTeam;
          setDeletingTeam(null);
          if (!name) return;
          void api(`/api/sidebar-sections?section=${encodeURIComponent(name)}`, { method: "DELETE" })
            .then(({ sections: names }) => dispatch({ type: "sections", sections: names }))
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
        }} />
    </main>
  );
}
