import { useState } from "react";
import { openExternalLink } from "@/lib/app-links";
import { cloudAccountBridge, cloudCard, PHONE_APP_URL, useCloudAccount } from "@/lib/cloud-account-view";
import { t } from "@/lib/i18n";
import { CloudSignInForm } from "./CloudSignInForm";
import { ConnectedPhones } from "./PairedPhones";

export function PhoneSetupFlow({ variant, onSkip, onComplete, compactHeader = false }: {
  variant: "settings" | "onboarding";
  onSkip?: () => void;
  onComplete?: () => void;
  compactHeader?: boolean;
}) {
  const bridge = cloudAccountBridge();
  const { account, accept, failed } = useCloudAccount(bridge);
  const card = cloudCard(account);
  const [actionFailed, setActionFailed] = useState(false);
  const email = card.kind === "signed-in" ? card.email : null;
  const openApp = async () => {
    setActionFailed(false);
    try { await openExternalLink(PHONE_APP_URL); }
    catch { setActionFailed(true); }
  };
  const refresh = async () => {
    if (!bridge) return;
    setActionFailed(false);
    try { accept(await bridge.refresh()); }
    catch { setActionFailed(true); }
  };
  return (
    <div data-phone-account-setup className="flex flex-col gap-4">
      {!compactHeader && <h2 id="phone-app-title" className="text-center text-[17px] font-medium text-ink">{t("phoneApp.title")}</h2>}
      <p className="text-center text-[13px] leading-relaxed text-ink">
        {email ? t("phoneApp.signedIn", { email }) : t("phoneApp.signedOut")}
      </p>
      <button type="button" className="ui-button self-center" data-phone-app-download onClick={() => void openApp()}>
        {t("phoneApp.openLink")}
      </button>
      <p className="text-center text-[12px] text-ink-secondary">{t("phoneApp.beta")}</p>
      {bridge && (card.kind === "signed-out" || card.kind === "reauth") && <CloudSignInForm bridge={bridge} onSignedIn={accept} />}
      {bridge && card.kind === "connecting" && <p role="status" className="text-center text-[13px] text-ink-secondary">{t("cloudAccount.continueInBrowser")}</p>}
      {bridge && (failed || card.kind === "unreachable") && <button type="button" className="ui-button self-center" onClick={() => void refresh()}>{t("cloudAccount.tryAgain")}</button>}
      {actionFailed && <p role="alert" className="text-center text-[13px] text-danger">{t("cloudAccount.actionFailed")}</p>}
      {variant === "settings" && <ConnectedPhones />}
      {variant === "onboarding" && <div className="flex flex-col gap-3">
        {email && <button type="button" className="ui-button" onClick={onComplete}>{t("onboarding.continue")}</button>}
        <button type="button" className="self-center text-[12.5px] text-ink-secondary hover:text-ink" onClick={onSkip}>{t("phone.intro.notNow")}</button>
      </div>}
    </div>
  );
}
