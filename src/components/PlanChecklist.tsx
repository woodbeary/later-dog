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
          {item.status === "done" ? <Check size={14} className="mt-0.5 shrink-0 text-ink-secondary" aria-hidden="true" />
            : item.status === "in_progress" && working ? <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-accent motion-reduce:animate-none" aria-hidden="true" />
              : item.status === "in_progress" ? <Circle size={12} className="mt-1 shrink-0 fill-accent text-accent" aria-hidden="true" />
                : <Circle size={12} className="mt-1 shrink-0 text-ink-tertiary" aria-hidden="true" />}
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
    <div className="ml-11 max-w-[520px]" data-dog-plan={open ? "open" : "folded"}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? t("chat.plan.hide") : t("chat.plan.show")}
        className="flex items-center gap-1 rounded-md text-[12px] text-ink-tertiary hover:text-ink-secondary focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
        {progress}
      </button>
      {open && <div className="mt-1.5"><PlanChecklist items={plan.items} working={false} label={t("chat.plan")} /></div>}
    </div>
  );
}
