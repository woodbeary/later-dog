import { useRef, useState } from "react";
import { KeyRound, Loader2, RefreshCw, X } from "lucide-react";
import { brand } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { useDesktopCapabilities } from "./DesktopCapabilities";

export function CredentialStoreNotice() {
  const { capabilities } = useDesktopCapabilities();
  const [dismissed, setDismissed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const retryInFlight = useRef(false);
  if (dismissed || (capabilities.credentialStore !== "unavailable" && capabilities.credentialStore !== "reset")) return null;
  const app = brand().name;
  if (capabilities.credentialStore === "reset") {
    return (
      <div
        className="animate-panel-in fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-[max(1rem,env(safe-area-inset-left))] z-50 w-[300px] rounded-xl border border-hairline/40 bg-panel p-3.5 shadow-2xl shadow-black/50"
        data-testid="credential-store-reset-notice"
      >
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
            <KeyRound size={14} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1 text-[12.5px] text-ink-secondary">{t("credentialStore.reset")}</div>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            title={t("credentialStore.later")}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }
  const retry = async () => {
    if (retryInFlight.current || !window.laterdog?.retryCredentialStore) return;
    retryInFlight.current = true;
    setRetrying(true);
    setRetryFailed(false);
    try {
      const result = await window.laterdog.retryCredentialStore();
      if (result.available) setDismissed(true);
      else setRetryFailed(true);
    } catch {
      setRetryFailed(true);
    } finally {
      retryInFlight.current = false;
      setRetrying(false);
    }
  };
  return (
    <div
      className="animate-panel-in fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-[max(1rem,env(safe-area-inset-left))] z-50 w-[300px] rounded-xl border border-hairline/40 bg-panel p-3.5 shadow-2xl shadow-black/50"
      data-testid="credential-store-notice"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <KeyRound size={14} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-ink">{t("credentialStore.title")}</div>
          <div className="mt-0.5 text-[12.5px] text-ink-secondary">{t("credentialStore.unavailable", { app })}</div>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
          title={t("credentialStore.later")}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {retryFailed && (
        <p role="alert" className="mt-2 text-[12.5px] text-danger">{t("credentialStore.retryFailed", { app })}</p>
      )}
      {window.laterdog?.retryCredentialStore && (
        <button
          type="button"
          onClick={() => void retry()}
          disabled={retrying}
          aria-busy={retrying}
          className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent py-1.5 text-[13px] font-medium text-white transition-colors enabled:hover:brightness-110 disabled:opacity-50"
        >
          {retrying ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <KeyRound size={13} aria-hidden="true" />}
          {t("credentialStore.retry")}
        </button>
      )}
      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          onClick={() => void window.laterdog?.relaunch?.().catch(() => setRetryFailed(true))}
          disabled={retrying}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control py-1.5 text-[13px] font-medium text-ink transition-colors enabled:hover:brightness-110 disabled:opacity-50"
        >
          <RefreshCw size={13} aria-hidden="true" /> {t("credentialStore.relaunch")}
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
        >
          {t("credentialStore.later")}
        </button>
      </div>
    </div>
  );
}
