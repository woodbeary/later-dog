import { t } from "@/lib/i18n";
import type { LiveScreen } from "@/lib/live-screens";
import { useStoreSelector } from "@/state/store-selectors";

export function MacScreenTileView({ name, busy, screen, onStop }: { name: string; busy: boolean; screen: LiveScreen | undefined; onStop: () => void }) {
  if (!screen || !busy) return null;
  return (
    <div data-mac-screen className="pointer-events-auto mx-5 mb-2 flex items-center gap-3 rounded-2xl border border-hairline/60 bg-raised p-1.5 pr-2 shadow-sm">
      <img
        src={`data:${screen.mime};base64,${screen.png}`}
        alt={t("chat.macScreen.alt", { name })}
        className="block h-[60px] w-[96px] shrink-0 rounded-[10px] bg-ink/[0.04] object-cover ring-[0.5px] ring-ink/10"
      />
      <span data-mac-screen-pill className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px] text-ink">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-accent animate-pulse motion-reduce:animate-none" />
        <span className="truncate">{t("chat.macScreen.using", { name })}</span>
      </span>
      <button
        type="button"
        data-mac-screen-stop
        onClick={onStop}
        aria-label={t("chat.stopTurn")}
        className="shrink-0 rounded-full bg-ink/[0.07] px-3 py-1 text-[12.5px] font-medium text-ink transition-colors hover:bg-ink/[0.12] motion-reduce:transition-none"
      >
        {t("chat.stop")}
      </button>
    </div>
  );
}

export function MacScreenTile({ threadId, name, busy, onStop }: { threadId: string; name: string; busy: boolean; onStop: () => void }) {
  const screen = useStoreSelector((state) => state.liveScreens[threadId]);
  return <MacScreenTileView name={name} busy={busy} screen={screen} onStop={onStop} />;
}
