// Saved sign-ins did not unlock: macOS asked at launch and the answer was
// Deny, or the keychain could not be read. One small card, bottom-left like
// the update popup, saying what to do (quit and reopen, then Always Allow);
// nothing else in the app changes. Only the desktop app's own page learns
// this (electron/capabilities.cjs credentialStore); a browser and a remote
// server's page never see it.
import { useState } from "react";
import { KeyRound, RefreshCw, X } from "lucide-react";
import { brand } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { useDesktopCapabilities } from "./DesktopCapabilities";

export function CredentialStoreNotice() {
  const { capabilities } = useDesktopCapabilities();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || capabilities.credentialStore !== "unavailable") return null;
  const app = brand().name;
  return (
    <div
      className="animate-panel-in fixed bottom-4 left-4 z-50 w-[300px] rounded-xl border border-hairline/40 bg-panel p-3.5 shadow-2xl shadow-black/50"
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
      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          onClick={() => void window.laterdog?.relaunch?.()}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-1.5 text-[13px] font-medium text-white transition-colors"
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
