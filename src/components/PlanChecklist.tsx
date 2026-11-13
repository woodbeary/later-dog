import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Circle, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { planDoneCount, type PlanItem, type WirePlan } from "../../shared/dog-plan";

export function PlanChecklist({ items, working, label }: { items: readonly PlanItem[]; working: boolean; label: string }) {
  return (
    <ul className="space-y-1" aria-label={label}>
      {items.map((item, index) => (
        <li key={index} className="flex items-start gap-2 text-[12.5px] leading-5" data-plan-status={item.status}>
          <span className="flex h-5 w-4 shrink-0 items-center justify-center" data-plan-icon aria-hidden="true">
            {item.status === "done" ? <Check size={14} className="text-ink-secondary" />
              : item.status === "in_progress" && working ? <Loader2 size={14} className="animate-spin text-accent motion-reduce:animate-none" />
                : item.status === "in_progress" ? <Circle size={12} className="fill-accent text-accent" />
                  : <Circle size={12} className="text-ink-tertiary" />}
          </span>
          <span className={cn(item.status === "done" ? "text-ink-secondary line-through decoration-ink-tertiary/60" : "text-ink")}>{item.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function DogPlan({ plan, working }: { plan?: WirePlan; working: boolean }) {
  const [open, setOpen] = useState(false);
  if (!plan?.items.length) return null;
  const progress = t("chat.plan.progress", { done: planDoneCount(plan), total: plan.items.length });
  if (working) return <div className="ml-11 max-w-[520px]" data-dog-plan="open"><PlanChecklist items={plan.items} working label={t("chat.plan")} /></div>;
  return (
    <div className="-mt-3 max-w-[520px]" data-dog-plan={open ? "open" : "folded"}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? t("chat.plan.hide") : t("chat.plan.show")}
        className="flex min-h-6 items-center gap-2 rounded-lg text-[12px] text-ink-secondary hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {progress}
        {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
      </button>
      {open && <div className="mt-1"><PlanChecklist items={plan.items} working={false} label={t("chat.plan")} /></div>}
    </div>
  );
}
