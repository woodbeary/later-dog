import { ListChecks } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { taskRows, tasksWaitingOnYou } from "@/lib/tasks";
import { useStore } from "@/state/store";

export function SidebarTasksRow({ iconRail }: { iconRail: boolean }) {
  const { state, dispatch } = useStore();
  const rows = taskRows(state.bots);
  if (rows.length === 0) return null;
  const waiting = tasksWaitingOnYou(rows);
  const label = waiting ? `${t("tasks.title")}, ${t("tasks.forYou", { count: waiting })}` : t("tasks.title");
  return (
    <div className={cn(iconRail ? "flex justify-center px-2 pb-1" : "px-2 pb-1")}>
      <button
        type="button"
        data-sidebar-tasks
        aria-current={state.tasksOpen ? "page" : undefined}
        aria-label={label}
        title={iconRail ? label : undefined}
        onClick={() => dispatch({ type: "showTasks" })}
        className={cn(
          "flex items-center gap-2.5 rounded-lg text-[14px] text-ink transition-colors hover:bg-raised/60",
          iconRail ? "size-9 justify-center" : "h-9 w-full px-3",
          state.tasksOpen && "bg-raised",
        )}
      >
        <ListChecks size={16} className="shrink-0 text-ink-secondary" />
        {!iconRail && <span className="min-w-0 flex-1 truncate text-left">{t("tasks.title")}</span>}
        {waiting > 0 && (
          <span className={cn("shrink-0 rounded-full bg-accent text-[11px] font-semibold tabular-nums text-white", iconRail ? "absolute ml-6 -mt-6 px-1.5" : "px-2 py-0.5")}>{waiting}</span>
        )}
      </button>
    </div>
  );
}
