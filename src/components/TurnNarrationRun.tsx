import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export function TurnNarrationRun({
  label,
  forceOpen = false,
  children,
}: {
  label: string;
  forceOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-center">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          title={open ? t("chat.run.hideProgress") : t("chat.run.showProgress")}
          className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[12.5px] text-ink-tertiary transition-colors hover:bg-control hover:text-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <span>{label}</span>
          <ChevronRight size={12} aria-hidden="true" className={cn("transition-transform", open && "rotate-90")} />
        </button>
      </div>
      {open && children}
    </div>
  );
}
