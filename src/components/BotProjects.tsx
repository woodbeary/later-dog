import { Folder, Plus } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export function FolderIcon({ emoji, size = 13 }: { emoji?: string; size?: number }) {
  return emoji ? <span aria-hidden="true" className="inline-flex shrink-0 items-center justify-center leading-none" style={{ width: size, fontSize: size }}>{emoji}</span>
    : <Folder aria-hidden="true" size={size} className="shrink-0" />;
}

export function NewThreadButton({ bot, className, compact = false, onCreated }: { bot: Bot; className?: string; compact?: boolean; onCreated?: () => void }) {
  const { dispatch } = useStore();
  const projects = bot.projects ?? [];
  const currentProject = projects.find((project) => project.id === bot.tasks?.find((task) => task.threadId === bot.threadId)?.projectId);
  return <button type="button" aria-label={t("task.newShort")} title={currentProject ? t("task.newIn", { name: currentProject.name }) : t("task.newShort")}
    onClick={() => {
      dispatch({ type: "newTask", botId: bot.id, ...(currentProject ? { projectId: currentProject.id } : {}) });
      onCreated?.();
    }}
    className={cn("flex min-w-0 items-center gap-2 rounded-lg px-2.5 text-left text-[12px] text-ink-secondary hover:bg-raised/60 hover:text-ink", compact ? "py-1 @max-4xl/chathead:h-[30px] @max-4xl/chathead:px-2" : "py-2", className)}>
    <Plus aria-hidden="true" size={12} /><span className={cn("truncate", compact && "@max-4xl/chathead:hidden")}>{t("task.newShort")}</span>
  </button>;
}
