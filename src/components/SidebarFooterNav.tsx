import { Bug } from "lucide-react";
import { useState } from "react";
import { t } from "@/lib/i18n";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { BugReportDialog } from "./BugReportDialog";

export function SidebarBugButton() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" data-sidebar-nav="bug-report" onClick={() => setOpen(true)}
      aria-label={t("bugReport.title")} title={t("bugReport.title")} aria-haspopup="dialog"
      className="flex size-9 shrink-0 items-center justify-center rounded-xl text-ink-secondary transition-colors hover:bg-raised/50 hover:text-ink">
      <Bug size={18} />
    </button>
    {open && <BugReportDialog onClose={() => setOpen(false)} />}
  </>;
}

export function SidebarFooterNav({ density }: { density: SidebarDensity }) {
  return density === "icons" ? <nav aria-label={t("sidebar.tools")}><SidebarBugButton /></nav> : null;
}
