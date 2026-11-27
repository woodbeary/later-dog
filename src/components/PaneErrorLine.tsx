import { LogIn, RefreshCw, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStoreDispatch, useStoreSelector } from "@/state/store-selectors";
import { paneErrorsFor, type PaneKey } from "@/state/pane-errors";

export type PaneErrorLook = "tray" | "row" | "icon";

export function PaneErrorLine({ panes, look = "row", quietLine = false, className }: {
  panes: readonly PaneKey[];
  look?: PaneErrorLook;
  quietLine?: boolean;
  className?: string;
}) {
  const dispatch = useStoreDispatch();
  const paneErrors = useStoreSelector((state) => state.paneErrors);
  const shown = paneErrorsFor(paneErrors, panes);
  if (!shown) return null;
  const { pane, error } = shown;
  const retry = () => dispatch({ type: "retryPane", pane });
  const signIn = () => dispatch({ type: "toggleAppSettings", open: true, section: "general" });
  const repeated = error.count && error.count > 1 ? `×${error.count}` : null;
  return (
    <div
      role="status"
      data-pane-error={pane}
      title={quietLine ? error.line : undefined}
      className={cn(
        "flex min-w-0 items-center gap-2 text-[13px] text-ink-secondary",
        look === "tray" && "pointer-events-auto mx-auto mb-2 w-full max-w-[min(48rem,calc(100%-2.5rem))] rounded-xl bg-card px-3 py-2 text-ink ring-[0.5px] ring-ink/10",
        className,
      )}
    >
      <span className={quietLine ? "sr-only" : "min-w-0 flex-1 break-words"}>{error.line}</span>
      {repeated && !quietLine && <span data-pane-error-count className="shrink-0 text-[12px] tabular-nums text-ink-tertiary">{repeated}</span>}
      {error.signIn && (look === "icon" ? (
        <button
          type="button"
          onClick={signIn}
          aria-label={t("accounts.signIn")}
          title={t("accounts.signIn")}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <LogIn size={14} aria-hidden="true" />
        </button>
      ) : (
        <button
          type="button"
          onClick={signIn}
          className="shrink-0 rounded-full bg-control px-3 py-1 text-[12.5px] font-medium text-ink hover:bg-control-hover"
        >
          {t("accounts.signIn")}
        </button>
      ))}
      {quietLine && !error.retryable && !error.signIn && <TriangleAlert size={14} aria-hidden="true" className="shrink-0" />}
      {error.retryable && (look === "icon" ? (
        <button
          type="button"
          onClick={retry}
          aria-label={t("pane.tryAgain")}
          title={t("pane.tryAgain")}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      ) : (
        <button
          type="button"
          onClick={retry}
          className="shrink-0 rounded-full bg-control px-3 py-1 text-[12.5px] font-medium text-ink hover:bg-control-hover"
        >
          {t("pane.tryAgain")}
        </button>
      ))}
    </div>
  );
}
