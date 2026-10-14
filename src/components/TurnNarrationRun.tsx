import { useEffect, useId, useState } from "react";
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
  const content = useId();
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex justify-center">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={content}
          title={open ? t("chat.run.hideProgress") : t("chat.run.showProgress")}
          className="flex min-w-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] leading-4 text-ink-tertiary transition-colors hover:bg-control hover:text-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronRight size={12} aria-hidden="true" className={cn("shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        </button>
      </div>
      <div id={content} hidden={!open} className={open ? "flex min-w-0 flex-col gap-2 border-s border-hairline/60 ps-3" : undefined}>
        {open && children}
      </div>
    </div>
  );
}
