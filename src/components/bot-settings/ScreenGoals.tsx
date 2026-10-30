import { useId, useMemo, useState } from "react";
import { Loader2, Monitor } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { screenGoals, type ScreenGoal, type ScreenStep } from "../../../shared/screen-goals";

export const STEPS_SHOWN = 6;
const LONG_GOAL_CHARS = 180;

export function stepWords(step: ScreenStep): string {
  if (step.action === "type") return step.detail ? t("goals.step.typeCount", { count: step.detail }) : t("goals.step.type");
  if (step.action === "key") return step.detail ? t("goals.step.key", { keys: step.detail }) : t("goals.step.keyPlain");
  if (step.action === "open") return step.detail ? t("goals.step.open", { place: step.detail }) : t("goals.step.openPlain");
  return t(`goals.step.${step.action}`);
}

export function ScreenGoals({ bot }: { bot: Pick<Bot, "messages" | "busy"> }) {
  const goals = useMemo(() => screenGoals(bot.messages ?? []), [bot.messages]);
  const [chosen, setChosen] = useState<string | null>(null);
  const index = chosen === null ? goals.length - 1 : goals.findIndex((goal) => goal.id === chosen);
  const goal = goals[index < 0 ? goals.length - 1 : index];
  if (!goal) return null;
  const position = goals.indexOf(goal);
  return (
    <section aria-label={t("goals.title")} data-screen-goals="" className="mt-4 flex flex-col gap-2">
      <GoalCard key={goal.id} goal={goal} working={goal.latest && Boolean(bot.busy)} />
      {goals.length > 1 && (
        <div className="flex items-center justify-center gap-1.5" data-goal-dots="">
          {goals.map((entry, at) => (
            <button
              key={entry.id}
              type="button"
              aria-label={t("goals.position", { position: at + 1, total: goals.length })}
              aria-current={at === position ? "step" : undefined}
              onClick={() => setChosen(at === goals.length - 1 ? null : entry.id)}
              className="flex h-5 w-4 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <span className={cn("h-1.5 w-1.5 rounded-full transition-colors motion-reduce:transition-none", at === position ? "bg-ink" : "bg-ink/25")} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function GoalCard({ goal, working }: { goal: ScreenGoal; working: boolean }) {
  const textId = useId();
  const [fullText, setFullText] = useState(false);
  const [allSteps, setAllSteps] = useState(false);
  const long = goal.text.length > LONG_GOAL_CHARS || goal.text.split("\n").length > 3;
  const steps = allSteps ? goal.steps : goal.steps.slice(-STEPS_SHOWN);
  return (
    <article aria-labelledby={textId} data-goal={goal.id} data-goal-status={working ? "working" : "done"} className="flex flex-col gap-2 rounded-xl bg-card px-4 py-3">
      <div className="flex items-center gap-2">
        <Monitor size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
        <span className="flex-1 text-[12px] font-medium text-ink-secondary">{t("goals.goal")}</span>
        <span role="status" className="flex items-center gap-1 text-[12px] text-ink-secondary">
          {working && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
          {t(working ? "goals.working" : "goals.done")}
        </span>
      </div>
      <p id={textId} dir="auto" className={cn("whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink", long && !fullText && "line-clamp-3")}>{goal.text}</p>
      {long && (
        <button type="button" aria-controls={textId} aria-expanded={fullText} onClick={() => setFullText((value) => !value)} className="self-start text-[12px] text-ink-secondary underline-offset-2 hover:underline">
          {t(fullText ? "goals.showLess" : "goals.showFull")}
        </button>
      )}
      <ol aria-label={t("goals.steps")} className="flex flex-col gap-1 border-t border-hairline/40 pt-2">
        {steps.map((step) => (
          <li key={step.id} data-step={step.action} className="flex items-center gap-2 text-[12.5px] text-ink-secondary">
            <span aria-hidden="true" className="h-1 w-1 shrink-0 rounded-full bg-ink/30" />
            <span className="min-w-0 flex-1 truncate">{stepWords(step)}</span>
            {!step.ok && <span className="shrink-0 text-[11px] text-danger">{t("goals.step.failed")}</span>}
          </li>
        ))}
      </ol>
      {goal.steps.length > STEPS_SHOWN && !allSteps && (
        <button type="button" onClick={() => setAllSteps(true)} className="self-start text-[12px] text-ink-secondary underline-offset-2 hover:underline">
          {t("goals.showSteps", { count: goal.steps.length })}
        </button>
      )}
    </article>
  );
}
