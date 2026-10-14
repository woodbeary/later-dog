import { useEffect, useRef, useState } from "react";
import { cloudAccountBridge, cloudCard, useCloudAccount } from "@/lib/cloud-account-view";
import { t } from "@/lib/i18n";
import { completionPatch } from "@/lib/onboarding";
import { api, useStore } from "@/state/store";

export function CloudSignInLine() {
  const bridge = cloudAccountBridge();
  const { dispatch } = useStore();
  const { account, accept } = useCloudAccount(bridge);
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);
  const opening = useRef(false);
  const card = cloudCard(account);
  const ready = card.kind === "signed-in" && card.home?.status === "ready";

  useEffect(() => {
    if (!bridge || !started || !ready || opening.current) return;
    opening.current = true;
    void (async () => {
      try {
        const config = await api("/api/config", { method: "PUT", body: JSON.stringify(completionPatch()), signal: AbortSignal.timeout(10_000) });
        dispatch({ type: "configStatus", config });
      } catch {}
      try {
        accept(await bridge.connectHome());
      } catch {
        opening.current = false;
        setStarted(false);
        setFailed(true);
      }
    })();
  }, [bridge, started, ready]);

  if (!bridge) return null;
  const begin = () => {
    setFailed(false);
    setStarted(true);
    if (card.kind === "signed-in") return;
    void bridge.begin().then(accept).catch(() => { setStarted(false); setFailed(true); });
  };
  const action = (label: string) => (
    <button type="button" onClick={begin} className="font-medium text-ink underline-offset-2 hover:underline">{label}</button>
  );

  let line: React.ReactNode;
  if (!started && card.kind === "signed-in") line = <>{t("onboarding.phone.prompt")} {action(t("cloudHome.connect"))}</>;
  else if (!started || card.kind === "signed-out" || card.kind === "loading") line = <>{t("onboarding.phone.prompt")} {action(t("cloudAccount.signIn"))}</>;
  else if (card.kind === "connecting") {
    line = <>{t("cloudAccount.continueInBrowser")}{card.code && <> · <code dir="ltr" className="font-semibold tracking-widest text-ink">{card.code}</code></>}</>;
  } else if (card.kind === "signed-in") line = t(ready ? "onboarding.phone.opening" : "cloudAccount.home.provisioning");
  else line = <>{t(card.kind === "reauth" ? "cloudAccount.reauth" : card.note)} {action(t("cloudAccount.tryAgain"))}</>;

  return (
    <div data-cloud-signin-line={started ? card.kind : "offer"} className="mt-5 flex min-h-[40px] flex-col items-center justify-center gap-1 text-center text-[13px] leading-relaxed text-ink-secondary">
      <p>{line}</p>
      {failed && <p role="alert" className="text-danger">{t("cloudAccount.actionFailed")}</p>}
    </div>
  );
}
