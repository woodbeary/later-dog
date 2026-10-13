import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { X } from "lucide-react";
import { openExternalLink } from "@/lib/app-links";
import { cloudAccountBridge, cloudCard, PHONE_APP_URL, useCloudAccount } from "@/lib/cloud-account-view";
import { t } from "@/lib/i18n";

export function PhoneAppDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <OpenPhoneAppDialog onClose={onClose} />;
}

function OpenPhoneAppDialog({ onClose }: { onClose: () => void }) {
  const bridge = cloudAccountBridge();
  const { account, accept } = useCloudAccount(bridge);
  const [failed, setFailed] = useState(false);
  const card = cloudCard(account);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const signIn = () => {
    if (!bridge) return;
    setFailed(false);
    void bridge.begin().then(accept).catch(() => setFailed(true));
  };
  const email = card.kind === "signed-in" ? card.email : null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="phone-app-title" data-phone-app-dialog=""
        className="relative w-full max-w-[400px] rounded-2xl border border-hairline/50 bg-panel p-6 text-center shadow-2xl">
        <button type="button" onClick={onClose} aria-label={t("common.close")} title={t("common.close")}
          className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink">
          <X size={16} />
        </button>
        <h2 id="phone-app-title" className="text-[17px] font-medium text-ink">{t("phoneApp.title")}</h2>
        <p className="mt-1 text-[13px] text-ink-secondary">{t("phoneApp.scan")}</p>
        <div className="mx-auto mt-5 w-fit rounded-xl bg-white p-3" data-phone-app-qr={PHONE_APP_URL}>
          <QRCodeSVG value={PHONE_APP_URL} size={168} level="M" bgColor="#ffffff" fgColor="#111111" />
        </div>
        <button type="button" className="mt-3 text-[13px] text-ink-secondary underline-offset-2 hover:text-ink hover:underline" onClick={() => void openExternalLink(PHONE_APP_URL).catch(() => window.open(PHONE_APP_URL, "_blank", "noopener,noreferrer"))}>
          {t("phoneApp.openLink")}
        </button>
        <p className="mt-4 text-[13px] leading-relaxed text-ink">
          {email ? t("phoneApp.signedIn", { email }) : t("phoneApp.signedOut")}
        </p>
        {bridge && card.kind !== "signed-in" && (
          <div data-phone-app-action={card.kind} className="mt-3 flex h-9 items-center justify-center">
            {card.kind === "connecting"
              ? <p role="status" className="text-[13px] text-ink-secondary">
                {t("cloudAccount.continueInBrowser")}{card.code && <> · <code dir="ltr" className="font-semibold tracking-widest text-ink">{card.code}</code></>}
              </p>
              : card.kind === "signed-out" && <button type="button" className="ui-button" onClick={signIn}>{t("cloudAccount.signInTitle")}</button>}
          </div>
        )}
        {failed && <p role="alert" className="mt-2 text-[13px] text-danger">{t("cloudAccount.actionFailed")}</p>}
        <p className="mt-4 text-[12px] text-ink-secondary">{t("phoneApp.beta")}</p>
      </div>
    </div>
  );
}
