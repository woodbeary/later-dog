import { useState } from "react";
import { Check, ListChecks, Loader2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { dogTasks, TASK_STATUS_LABEL, tasksWaitingOnYou, type DogTask } from "@/lib/tasks";
import { useStore, type Bot } from "@/state/store";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";

function StatusMark({ row }: { row: DogTask }) {
  if (row.status === "working") return <Loader2 size={14} aria-hidden="true" className="shrink-0 animate-spin text-ink-tertiary" />;
  if (row.status !== "needsYou" && row.status !== "review") return null;
  return <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", row.status === "needsYou" ? "bg-warning" : "bg-accent")} />;
}

export function ChatHeaderTasks({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [doneShown, setDoneShown] = useState(false);
  const tasks = dogTasks(bot);
  if (tasks.length === 0) return null;
  const doneCount = tasks.filter((row) => row.status === "done").length;
  const waiting = tasksWaitingOnYou(tasks);
  const needsYou = tasks.some((row) => row.status === "needsYou");
  const label = waiting ? `${t("tasks.title")}, ${t("tasks.forYou", { count: waiting })}` : t("tasks.title");
  const items: SidebarMenuItem[] = tasks
    .filter((row) => doneShown || row.status !== "done")
    .map((row) => {
      const done = row.status === "done";
      return {
        key: row.task.threadId,
        label: row.task.title,
        subtitle: t(TASK_STATUS_LABEL[row.status]),
        trailing: <StatusMark row={row} />,
        action: {
          label: t(done ? "tasks.reopen" : "tasks.markDone"),
          icon: done ? <RotateCcw size={15} /> : <Check size={15} />,
          onSelect: () => dispatch({ type: "markTaskDone", botId: bot.id, threadId: row.task.threadId, done: !done }),
        },
        onSelect: () => dispatch({ type: "openTask", botId: bot.id, threadId: row.task.threadId }),
      };
    });
  if (doneCount > 0) {
    items.push({
      key: "done-tasks",
      label: t(doneShown ? "tasks.hideDone" : "tasks.showDone"),
      separatorBefore: items.length > 0,
      keepOpen: true,
      onSelect: () => setDoneShown((shown) => !shown),
    });
  }
  return (
    <SidebarPopoverMenu
      items={items}
      ariaLabel={label}
      placement="below"
      renderTrigger={({ open }) => (
        <span
          data-chat-tasks={waiting}
          title={label}
          className={cn("relative flex rounded-md p-1.5 hover:bg-raised", open ? "text-accent" : "text-ink-secondary hover:text-ink")}
        >
          <ListChecks size={18} />
          {waiting > 0 && <span aria-hidden="true" className={cn("absolute right-1 top-1 size-2 rounded-full", needsYou ? "bg-warning" : "bg-accent")} />}
        </span>
      )}
    />
  );
}
