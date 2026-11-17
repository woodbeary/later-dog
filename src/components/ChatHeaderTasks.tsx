import { useState } from "react";
import { Check, Copy, Download, Loader2, MessageSquarePlus, MoreHorizontal, RotateCcw, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { dogTasks, TASK_STATUS_LABEL, tasksWaitingOnYou, type DogTask } from "@/lib/tasks";
import type { Bot, Message } from "@/state/store";
import { useStoreDispatch } from "@/state/store-selectors";
import { startNewConversation } from "@/lib/new-conversation";
import { copyTranscriptToClipboard, downloadMarkdownTranscript, formatTranscriptMarkdown, slugifyTranscriptFilename } from "@/lib/export-transcript";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";

function StatusMark({ row }: { row: DogTask }) {
  if (row.status === "working") return <Loader2 size={14} aria-hidden="true" className="shrink-0 animate-spin text-ink-tertiary" />;
  if (row.status !== "needsYou" && row.status !== "review") return null;
  return <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", row.status === "needsYou" ? "bg-warning" : "bg-accent")} />;
}

function useTaskItems(bot: Bot): { items: SidebarMenuItem[]; waiting: number; needsYou: boolean } {
  const dispatch = useStoreDispatch();
  const [doneShown, setDoneShown] = useState(false);
  const tasks = dogTasks(bot);
  const doneCount = tasks.filter((row) => row.status === "done").length;
  const items: SidebarMenuItem[] = tasks
    .filter((row) => doneShown || row.status !== "done")
    .map((row) => {
      const done = row.status === "done";
      return {
        key: `task:${row.task.threadId}`,
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
      keepOpen: true,
      onSelect: () => setDoneShown((shown) => !shown),
    });
  }
  if (items[0]) items[0] = { ...items[0], heading: t("tasks.title"), separatorBefore: true };
  return { items, waiting: tasksWaitingOnYou(tasks), needsYou: tasks.some((row) => row.status === "needsYou") };
}

export function ChatHeaderMenu({ bot, messages, onFind }: { bot: Bot; messages: readonly Message[]; onFind: () => void }) {
  const dispatch = useStoreDispatch();
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);
  const tasks = useTaskItems(bot);
  const hasMessages = messages.length > 0;
  const transcript = () => formatTranscriptMarkdown({ title: bot.name, messages, botName: bot.name, isGroup: false });
  const items: SidebarMenuItem[] = [
    {
      key: "new",
      label: t("chat.newConversation"),
      icon: <MessageSquarePlus size={16} />,
      disabled: !hasMessages,
      onSelect: () => {
        void startNewConversation(bot.id)
          .then((threadId) => dispatch({ type: "openTask", botId: bot.id, threadId }))
          .catch(() => window.alert(t("chat.newConversationFailed")));
      },
    },
    {
      key: "find",
      label: t("chat.find"),
      icon: <Search size={16} />,
      trailing: <span className="text-[12px] text-ink-secondary">⌘F</span>,
      onSelect: onFind,
    },
    ...tasks.items,
    {
      key: "copy",
      heading: t("chat.export.heading"),
      separatorBefore: true,
      label: t("chat.export.copy"),
      icon: <Copy size={16} />,
      disabled: !hasMessages,
      keepOpen: true,
      trailing: copyStatus && <span role="status" className="text-[11px] text-ink-secondary">{t(copyStatus === "copied" ? "chat.export.copied" : "chat.export.copyFailed")}</span>,
      onSelect: () => { void copyTranscriptToClipboard(transcript()).then((ok) => setCopyStatus(ok ? "copied" : "failed")); },
    },
    {
      key: "download",
      label: t("chat.export.download"),
      icon: <Download size={16} />,
      disabled: !hasMessages,
      onSelect: () => downloadMarkdownTranscript(slugifyTranscriptFilename(bot.name), transcript()),
    },
  ];
  return (
    <SidebarPopoverMenu
      items={items}
      ariaLabel={t("chat.more")}
      placement="below"
      renderTrigger={({ open }) => (
        <span
          data-testid="chat-more"
          data-chat-tasks={tasks.waiting}
          title={t("chat.more")}
          className={cn("relative flex size-7 items-center justify-center rounded-full hover:bg-raised", open ? "text-ink" : "text-ink-secondary hover:text-ink")}
        >
          <MoreHorizontal size={18} />
          {tasks.waiting > 0 && <span aria-hidden="true" className={cn("absolute right-0.5 top-0.5 size-2 rounded-full", tasks.needsYou ? "bg-warning" : "bg-accent")} />}
        </span>
      )}
    />
  );
}
