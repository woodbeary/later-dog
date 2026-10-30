import { useEffect } from "react";
import { ArrowLeft, Check, Loader2, RotateCcw } from "lucide-react";
import { t } from "@/lib/i18n";
import { findTask, taskStatus } from "@/lib/tasks";
import { api, useStore, type Bot } from "@/state/store";
import type { TaskView } from "@/state/task-view";
import { ChatView } from "./ChatView";

export function TaskChat({ view }: { view: TaskView }) {
  const { state, dispatch } = useStore();
  const found = findTask(state.bots, view.botId, view.threadId);
  const owner = found?.bot ?? state.bots.find((bot) => bot.id === view.botId);
  const back = () => dispatch({ type: "closeTask" });
  const status = found ? taskStatus(found.task) : null;
  const unread = Boolean(found?.task.unread) && !view.loading;
  useEffect(() => {
    if (unread) api(`/api/bots/${view.botId}/read`, { method: "POST", body: JSON.stringify({ threadId: view.threadId }) }).catch(() => {});
  }, [unread, view.botId, view.threadId]);
  const taskBot: Bot | null = found ? { ...found.bot, threadId: view.threadId, messages: view.messages, hasMore: view.hasMore, activeLeafId: view.activeLeafId } : null;
  return (
    <div data-open-task={view.threadId} className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline/40 px-3">
        <button type="button" onClick={back} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">
          <ArrowLeft size={14} />{owner ? t("tasks.backTo", { name: owner.name }) : t("tasks.back")}
        </button>
        <div className="min-w-0 flex-1 truncate text-center text-[13px] font-medium text-ink">
          {found?.task.title}
          {found?.task.openedBy && <span className="ml-2 font-normal text-ink-secondary">{t("tasks.startedBy", { name: found.task.openedBy.name })}</span>}
        </div>
        {found && status && (
          <button
            type="button"
            data-task-done={status === "done" ? "reopen" : "done"}
            onClick={() => dispatch({ type: "markTaskDone", botId: found.bot.id, threadId: view.threadId, done: status !== "done" })}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            {status === "done" ? <RotateCcw size={14} /> : <Check size={14} />}
            {t(status === "done" ? "tasks.reopen" : "tasks.markDone")}
          </button>
        )}
      </div>
      {!taskBot ? (
        <p className="mt-16 text-center text-[13.5px] text-ink-secondary">{t("tasks.gone")}</p>
      ) : view.loading ? (
        <div className="flex flex-1 items-center justify-center text-ink-secondary"><Loader2 size={18} className="animate-spin" /></div>
      ) : view.failed ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[13.5px] text-ink-secondary">
          <p>{t("tasks.loadFailed")}</p>
          <button type="button" onClick={() => dispatch({ type: "openTask", botId: view.botId, threadId: view.threadId })} className="rounded-full border border-hairline/50 px-4 py-1.5 text-ink hover:bg-raised">
            {t("tasks.retry")}
          </button>
        </div>
      ) : (
        <ChatView key={view.threadId} bot={taskBot} />
      )}
    </div>
  );
}
