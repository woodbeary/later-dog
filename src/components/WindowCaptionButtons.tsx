import { useEffect, useState, type CSSProperties } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export function WindowCaptionButtons({ visible }: { visible: boolean }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const controls = window.laterdog?.windowControls;
    if (!controls) return;
    let alive = true;
    void controls.state().then(({ maximized }) => {
      if (alive) setMaximized(maximized);
    });
    const unsubscribe = controls.onMaximizedChanged((value) => setMaximized(value));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  if (!visible) return null;
  const controls = window.laterdog?.windowControls;

  const noDrag = { WebkitAppRegion: "no-drag" } as CSSProperties;
  const captionButton = cn(
    "flex h-[26px] w-11 items-center justify-center text-ink-secondary",
    "hover:bg-raised hover:text-ink active:bg-raised/60",
  );

  return (
    <div
      aria-hidden
      style={noDrag}
      className="absolute right-0 top-0 z-40 flex items-stretch"
    >
      <button
        type="button"
        aria-label={t("window.minimize")}
        title={t("window.minimize")}
        className={captionButton}
        onClick={() => void controls?.minimize()}
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        aria-label={maximized ? t("window.restore") : t("window.maximize")}
        title={maximized ? t("window.restore") : t("window.maximize")}
        className={captionButton}
        onClick={() => void controls?.toggleMaximize()}
      >
        {maximized ? <Copy size={11} /> : <Square size={11} />}
      </button>
      <button
        type="button"
        aria-label={t("window.close")}
        title={t("window.close")}
        className={cn(captionButton, "hover:bg-danger/25 hover:text-danger")}
        onClick={() => void controls?.close()}
      >
        <X size={15} />
      </button>
    </div>
  );
}
