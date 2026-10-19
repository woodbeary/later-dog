import { Puzzle } from "lucide-react";
import { t } from "@/lib/i18n";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { useStore } from "@/state/store";

export function ConnectAppsPill() {
  const { dispatch } = useStore();
  return (
    <button
      type="button"
      data-sidebar-nav="connect-apps"
      onClick={() => dispatch({ type: "togglePlugins", open: true, surface: "apps" })}
      className="flex h-9 min-w-0 flex-1 items-center justify-center rounded-full border border-hairline/50 px-4 text-[13.5px] font-medium text-ink transition-colors hover:bg-raised/60"
    >
      <span className="truncate">{t("sidebar.connectApps")}</span>
    </button>
  );
}

export function SidebarFooterNav({ density }: { density: SidebarDensity }) {
  const { dispatch } = useStore();
  if (density !== "icons") return null;
  return (
    <nav aria-label={t("sidebar.tools")}>
      <button
        type="button"
        data-sidebar-nav="connect-apps"
        onClick={() => dispatch({ type: "togglePlugins", open: true, surface: "apps" })}
        aria-label={t("sidebar.connectApps")}
        title={t("sidebar.connectApps")}
        className="flex size-9 shrink-0 items-center justify-center rounded-xl text-ink-secondary transition-colors hover:bg-raised/50 hover:text-ink"
      >
        <Puzzle size={18} />
      </button>
    </nav>
  );
}
