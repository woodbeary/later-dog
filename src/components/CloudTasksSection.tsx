import { ChevronRight, Cloud } from "lucide-react";

import { cn } from "@/lib/cn";
import { cloudTaskStatus, cloudTaskStatusClass, projectName, useBotCloudTasks } from "@/lib/cloud-tasks";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";

export function CloudTasksSection({ botId, botName }: { botId: string; botName: string }) {
  const { dispatch } = useStore();
  const { tasks } = useBotCloudTasks(botId);
  if (!tasks?.length) return null;
  return (
    <section className="mt-5" data-testid="computer-cloud-tasks">
      <h3 className="mb-1.5 flex items-center gap-1.5 text-[13px] text-ink-secondary">
        <Cloud size={14} aria-hidden="true" />
        {t("cloudTask.listTitle", { name: botName })}
      </h3>
      <ul className="overflow-hidden rounded-xl bg-card">
        {tasks.map((task) => {
          const status = cloudTaskStatus({ summary: task });
          // what it is doing while it works; afterwards, the project it worked in
          const line = (status.live ? status.note : undefined) ?? projectName(task.repository);
          return (
            <li key={task.id} className="border-b border-hairline/30 last:border-b-0">
              <button
                type="button"
                onClick={() => dispatch({ type: "openCloudTask", jobId: task.id })}
                className="group flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left hover:bg-raised"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-ink">{task.title}</div>
                  <div className="truncate text-[12px] text-ink-secondary">{line}</div>
                </div>
                <span className={cn("shrink-0 text-[11.5px] font-medium", cloudTaskStatusClass(status))}>{status.label}</span>
                <ChevronRight size={14} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
