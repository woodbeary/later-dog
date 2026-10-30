import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/cn";
import { codingJobLine, dogCloudTasks } from "@/lib/cloud-tasks";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import type { CloudTaskSummary } from "../../../shared/cloud-task";

const SHOWN = 5;
const groupLabelCls = "mb-1.5 block px-1 text-[12px] font-medium text-ink-secondary";
const rowCls = "px-4 py-3";
const dividedRowCls = "border-t border-hairline/40 px-4 py-3";

export function CodingJobs({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [jobs, setJobs] = useState<CloudTaskSummary[]>([]);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    dogCloudTasks(bot.id).then((found) => { if (!cancelled) setJobs(found); }).catch(() => { if (!cancelled) setJobs([]); });
    return () => { cancelled = true; };
  }, [bot.id]);

  if (!jobs.length) return null;
  const shown = all ? jobs : jobs.slice(0, SHOWN);
  return (
    <div data-coding-jobs>
      <span className={groupLabelCls}>{t("botSettings.simple.codingJobs")}</span>
      <div className="rounded-xl bg-card">
        {shown.map((job, index) => (
          <button
            key={job.id}
            type="button"
            data-coding-job={job.id}
            onClick={() => dispatch({ type: "openCloudTask", jobId: job.id })}
            className={cn(index === 0 ? rowCls : dividedRowCls, "flex w-full items-center gap-3 text-left outline-none hover:bg-raised/40 focus-visible:ring-1 focus-visible:ring-focus")}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium text-ink">{job.title}</span>
              <span className="block truncate text-[12px] text-ink-secondary">{codingJobLine(job)}</span>
            </span>
            <ChevronRight size={15} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
          </button>
        ))}
        {jobs.length > SHOWN && (
          <button type="button" onClick={() => setAll((open) => !open)}
            className={cn(dividedRowCls, "block w-full text-left text-[12.5px] text-ink-secondary hover:text-ink")}>
            {all ? t("botSettings.simple.codingJobsFewer") : t("botSettings.simple.codingJobsAll", { count: jobs.length })}
          </button>
        )}
      </div>
    </div>
  );
}
