import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CirclePlay, Pause, Pencil, Play, Trash2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { appendComposerDraft, getDraft } from "@/lib/drafts";
import { t } from "@/lib/i18n";
import { latestRoutineRun, routineDateTime, routineRunLabel, routineRunMessageId, routineRunTime } from "@/lib/routine-display";
import type { Routine } from "@/lib/routines";
import { scheduleLabel } from "@/lib/schedule-label";
import { useStore, type Bot } from "@/state/store";
import { ConfirmDialog } from "../ConfirmDialog";
import { PaneErrorLine } from "../PaneErrorLine";
import { Switch } from "../SettingsPrimitives";

const cardCls = "rounded-xl bg-card";
const rowCls = "px-4 py-3";
const dividedRowCls = "border-t border-hairline/40 px-4 py-3";
const menuItemCls = "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[13px] text-ink hover:bg-raised/70";

function draftHas(id: string, text: string): boolean {
  try {
    return getDraft(globalThis.localStorage, id).includes(text);
  } catch {
    return false;
  }
}

const SIDE_BY_SIDE = "(min-width: 768px)";

export function RoutinesCard({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const [menu, setMenu] = useState<{ routineId: string; left: number; top: number } | null>(null);
  const [deleting, setDeleting] = useState<Routine | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const routines = state.routines
    .filter((routine) => routine.botId === bot.id)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
  const menuRoutine = menu ? routines.find((routine) => routine.id === menu.routineId) : undefined;

  const openMenu = (routineId: string, x: number, y: number) =>
    setMenu({ routineId, left: Math.max(8, Math.min(x, window.innerWidth - 188)), top: Math.max(8, Math.min(y, window.innerHeight - 184)) });

  useEffect(() => {
    if (!menu) return;
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
      }
    };
    window.addEventListener("mousedown", outside);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  const toggle = (routine: Routine) =>
    dispatch({ type: "updateRoutine", routineId: routine.id, patch: { enabled: !routine.enabled } });

  const edit = (routine: Routine) => {
    setMenu(null);
    const draftId = `bot:${bot.id}:${bot.threadId}`;
    const text = t("routines.editDraft", { name: routine.name });
    if (!draftHas(draftId, text)) appendComposerDraft(draftId, text);
    dispatch({ type: "toggleSettings", open: false });
  };

  return (
    <>
      <div className={cardCls} data-simple-routines>
        <PaneErrorLine panes={["routines"]} className={cn(rowCls, routines.length > 0 && "border-b border-hairline/40")} />
        {routines.length === 0 ? (
          state.paneErrors.routines ? null : state.routinesLoadState !== "ready" ? (
            <div role="status" className={cn(rowCls, "text-[13px] text-ink-secondary")}>{t("routines.loading")}</div>
          ) : (
            <div className={cn(rowCls, "text-[13px] leading-relaxed text-ink-secondary")}>
              {t("botSettings.simple.routinesEmpty", { name: bot.name })}
            </div>
          )
        ) : (
          routines.map((routine, index) => {
            const lastRun = latestRoutineRun(routine.id, state.routineRuns);
            const lastRunText = lastRun && t("routines.lastRun", { time: routineDateTime(routineRunTime(lastRun)), status: routineRunLabel(lastRun) });
            const lastRunMessage = lastRun && routineRunMessageId(lastRun.id, bot.messages);
            return (
              <div key={routine.id} className={cn(index === 0 ? rowCls : dividedRowCls, "flex items-center gap-3")}>
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    data-routine={routine.id}
                    aria-haspopup="menu"
                    aria-expanded={menu?.routineId === routine.id}
                    onClick={(event) => {
                      if (menu?.routineId === routine.id) {
                        setMenu(null);
                        return;
                      }
                      const rect = event.currentTarget.getBoundingClientRect();
                      openMenu(routine.id, rect.left, rect.bottom + 4);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      openMenu(routine.id, event.clientX, event.clientY);
                    }}
                    className="block w-full min-w-0 rounded-md text-left outline-none focus-visible:ring-1 focus-visible:ring-focus"
                  >
                    <div className="truncate text-[13.5px] font-medium text-ink">{routine.name}</div>
                    <div className="truncate text-[12px] text-ink-secondary">
                      {routine.enabled ? scheduleLabel(routine.schedule) : t("routines.pausedSchedule")}
                    </div>
                  </button>
                  {lastRun && lastRunMessage ? (
                    <button
                      type="button"
                      data-routine-last-run={lastRun.id}
                      onClick={() => {
                        dispatch({ type: "focusMessage", threadId: bot.threadId, messageId: lastRunMessage });
                        if (!window.matchMedia?.(SIDE_BY_SIDE)?.matches) dispatch({ type: "toggleSettings", open: false });
                      }}
                      className="block max-w-full truncate rounded-md text-left text-[12px] text-ink-tertiary outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-focus"
                    >
                      {lastRunText}
                    </button>
                  ) : lastRun ? (
                    <div data-routine-last-run={lastRun.id} className="truncate text-[12px] text-ink-tertiary">{lastRunText}</div>
                  ) : null}
                </div>
                <Switch
                  checked={routine.enabled}
                  aria-label={t("routines.toggleAria", { name: routine.name })}
                  onClick={() => toggle(routine)}
                />
              </div>
            );
          })
        )}
      </div>
      {menu && menuRoutine && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={t("routines.actions", { name: menuRoutine.name })}
          style={{ left: menu.left, top: menu.top }}
          className="fixed z-50 w-[180px] overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/60 outline-none"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setMenu(null);
            }
          }}
        >
          <button
            type="button"
            role="menuitem"
            data-routine-action="run"
            onClick={() => {
              setMenu(null);
              dispatch({ type: "runRoutine", routineId: menuRoutine.id });
            }}
            className={menuItemCls}
          >
            <CirclePlay size={15} className="text-ink-secondary" />
            {t("routines.runNow")}
          </button>
          <button
            type="button"
            role="menuitem"
            data-routine-action="pause"
            onClick={() => {
              setMenu(null);
              toggle(menuRoutine);
            }}
            className={menuItemCls}
          >
            {menuRoutine.enabled ? <Pause size={15} className="text-ink-secondary" /> : <Play size={15} className="text-ink-secondary" />}
            {menuRoutine.enabled ? t("routines.pause") : t("routines.resume")}
          </button>
          <button type="button" role="menuitem" data-routine-action="edit" onClick={() => edit(menuRoutine)} className={menuItemCls}>
            <Pencil size={15} className="text-ink-secondary" />
            {t("routines.edit")}
          </button>
          <div className="mx-2 my-1 border-t border-hairline/40" />
          <button
            type="button"
            role="menuitem"
            data-routine-action="delete"
            onClick={() => {
              setMenu(null);
              setDeleting(menuRoutine);
            }}
            className={cn(menuItemCls, "text-danger")}
          >
            <Trash2 size={15} />
            {t("routines.delete")}
          </button>
        </div>,
        document.body,
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={t("routines.deleteConfirm")}
        body={t("routines.deleteBody", { name: deleting?.name ?? "" })}
        confirmLabel={t("routines.delete")}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) dispatch({ type: "deleteRoutine", routineId: deleting.id });
          setDeleting(null);
        }}
      />
    </>
  );
}
