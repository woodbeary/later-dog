import { useEffect, useState } from "react";
import { ArrowLeft, Check, Loader2, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { findTask, TASK_STATUS_LABEL, taskRows, taskSections, taskStatus, type TaskRow, type TaskSort } from "@/lib/tasks";
import { api, useStore, type Bot } from "@/state/store";
import type { TaskView } from "@/state/task-view";
import { BotAvatar } from "./Avatar";
import { ChatView } from "./ChatView";

const SORT_KEY = "laterdog-tasks-sort";
const SORTS: readonly TaskSort[] = ["status", "dog"];

function storedSort(): TaskSort {
  try {
    return localStorage.getItem(SORT_KEY) === "dog" ? "dog" : "status";
  } catch {
    return "status";
  }
}

function DoneButton({ row }: { row: TaskRow }) {
  const { dispatch } = useStore();
  const done = row.status === "done";
  const Icon = done ? RotateCcw : Check;
  return (
    <button
      type="button"
      data-task-done={done ? "reopen" : "done"}
      onClick={() => dispatch({ type: "markTaskDone", botId: row.bot.id, threadId: row.task.threadId, done: !done })}
      aria-label={t(done ? "tasks.reopenAria" : "tasks.markDoneAria", { title: row.task.title })}
      title={t(done ? "tasks.reopen" : "tasks.markDone")}
      className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 touch:opacity-100"
    >
      <Icon size={15} />
    </button>
  );
}

function TaskRowItem({ row, sort }: { row: TaskRow; sort: TaskSort }) {
  const { dispatch } = useStore();
  const detail = sort === "status" ? row.bot.name : t(TASK_STATUS_LABEL[row.status]);
  return (
    <li className="group flex items-center gap-1 rounded-lg pr-1 hover:bg-raised/50">
      <button
        type="button"
        data-task-row={row.task.threadId}
        data-task-status={row.status}
        onClick={() => dispatch({ type: "openTask", botId: row.bot.id, threadId: row.task.threadId })}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left"
      >
        <BotAvatar bot={row.bot} size={28} />
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-[14px] text-ink", row.status === "done" && "text-ink-secondary")}>{row.task.title}</span>
          <span className="block truncate text-[12px] text-ink-secondary">{detail}</span>
        </span>
        {row.status === "working" && <Loader2 size={14} aria-hidden="true" className="shrink-0 animate-spin text-ink-tertiary" />}
        {(row.status === "needsYou" || row.status === "review") && (
          <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", row.status === "needsYou" ? "bg-warning" : "bg-accent")} />
        )}
      </button>
      <DoneButton row={row} />
    </li>
  );
}

function TaskList() {
  const { state, dispatch } = useStore();
  const [sort, setSort] = useState<TaskSort>(storedSort);
  const sections = taskSections(taskRows(state.bots), sort);
  const choose = (next: TaskSort) => {
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      return;
    }
  };
  return (
    <main data-tasks-page className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline/40 px-4">
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{t("tasks.title")}</h1>
        <div role="radiogroup" aria-label={t("tasks.sortBy")} className="inline-flex shrink-0 rounded-full bg-inset p-0.5">
          {SORTS.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={sort === option}
              onClick={() => choose(option)}
              className={cn("rounded-full px-3 py-1 text-[12.5px] font-medium", sort === option ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}
            >
              {t(option === "status" ? "tasks.sort.status" : "tasks.sort.dog")}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => dispatch({ type: "closeTasks" })}
          aria-label={t("tasks.close")}
          title={t("tasks.close")}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={16} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {sections.length === 0 ? (
          <p className="mx-auto mt-16 max-w-sm text-center text-[13.5px] leading-relaxed text-ink-secondary">{t("tasks.empty")}</p>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-5">
            {sections.map((section) => (
              <section key={section.key} data-task-section={section.key} aria-label={section.status ? t(TASK_STATUS_LABEL[section.status]) : section.bot!.name}>
                <h2 className="mb-1 flex items-center gap-2 px-3 text-[12px] font-medium text-ink-secondary">
                  <span className="truncate">{section.status ? t(TASK_STATUS_LABEL[section.status]) : section.bot!.name}</span>
                  <span className="tabular-nums text-ink-tertiary">{section.rows.length}</span>
                </h2>
                <ul className="flex flex-col">
                  {section.rows.map((row) => <TaskRowItem key={row.task.threadId} row={row} sort={sort} />)}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function OpenTask({ view }: { view: TaskView }) {
  const { state, dispatch } = useStore();
  const found = findTask(state.bots, view.botId, view.threadId);
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
          <ArrowLeft size={14} />{t("tasks.back")}
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

export function TasksPage() {
  const { state } = useStore();
  return state.taskView ? <OpenTask view={state.taskView} /> : <TaskList />;
}
