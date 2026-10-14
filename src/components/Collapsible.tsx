import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { useCollapsePhase } from "@/lib/collapse-phase";

export function Collapsible({
  open,
  className,
  children,
}: {
  open: boolean;
  className?: string;
  children: ReactNode;
}) {
  const phase = useCollapsePhase(open);
  if (!phase.mounted) return null;
  return (
    <div className="collapsible" data-open={phase.open} data-settled={phase.settled}>
      <div className={cn("collapsible-inner", className)}>{children}</div>
    </div>
  );
}
