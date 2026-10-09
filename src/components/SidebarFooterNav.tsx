import { Puzzle } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { useStore } from "@/state/store";


function NavRow({
  id,
  label,
  icon,
  active = false,
  iconsOnly,
  tourId,
  onClick,
}: {
  id: string;
  label: string;
  icon: (active: boolean) => ReactNode;
  active?: boolean;
  iconsOnly: boolean;
  tourId?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-tour={tourId}
      data-sidebar-nav={id}
      onClick={onClick}
      aria-label={iconsOnly ? label : undefined}
      title={iconsOnly ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex w-full items-center rounded-xl text-left transition-colors",
        iconsOnly ? "min-h-10 justify-center px-2 py-2" : "min-h-9 gap-3 px-3 py-1.5",
        active ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
      )}
    >
      {icon(active)}
      {!iconsOnly && <span className="flex-1 truncate text-[14px]">{label}</span>}
    </button>
  );
}

/** Apps, as a round icon button at the end of the profile row. */
export function SidebarAppsButton() {
  const { state, dispatch } = useStore();
  const label = t("sidebar.nav.apps");
  return (
    <button
      type="button"
      data-tour="nav-apps"
      data-sidebar-nav="apps"
      onClick={() => dispatch({ type: "togglePlugins", open: true })}
      aria-label={label}
      title={label}
      aria-pressed={state.pluginsOpen}
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors",
        state.pluginsOpen ? "bg-raised text-accent" : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
      )}
    >
      <Puzzle size={18} />
    </button>
  );
}

export function SidebarFooterNav({ density }: { density: SidebarDensity }) {
  const { state, dispatch } = useStore();
  const iconsOnly = density === "icons";
  const iconSize = iconsOnly ? 20 : 18;
  const tone = (active: boolean) => (active ? "text-accent" : "text-ink-secondary");

  if (!iconsOnly) return null;
  return (
    // `tools` is the guided tour's anchor for "the places down here".
    <nav data-tour="tools" aria-label={t("sidebar.tools")} className="flex flex-col gap-0.5">
      <NavRow
        id="apps"
        label={t("sidebar.nav.apps")}
        tourId="nav-apps"
        iconsOnly={iconsOnly}
        active={state.pluginsOpen}
        icon={(active) => <Puzzle size={iconSize} className={tone(active)} />}
        onClick={() => dispatch({ type: "togglePlugins", open: true })}
      />
    </nav>
  );
}
