import { useEffect, useState } from "react";
import type { CloudAccountBridge, CloudAccountState } from "../../electron/cloud-account.mjs";
import { DogAvatar } from "@/components/Avatar";
import { CloudSignInForm } from "@/components/CloudSignInForm";
import { QuietButton } from "@/components/onboarding/beats/shared";
import { brand } from "@/lib/brand";
import { cloudAccountBridge, cloudCard, useCloudAccount } from "@/lib/cloud-account-view";
import { gateLine, offerStatus } from "@/lib/cloud-sign-in-view";
import { t } from "@/lib/i18n";

const SLOW_OPENING_MS = 15_000;

export interface CloudSignInGateHandle {
  bridge: CloudAccountBridge | undefined;
  account: CloudAccountState | null;
  accept: (next: CloudAccountState) => void;
  open: boolean;
  holding: boolean;
  decline: () => void;
}

export function useCloudSignInGate(): CloudSignInGateHandle {
  const bridge = window.laterdog?.remoteClient !== undefined ? cloudAccountBridge() : undefined;
  const { account, failed, accept } = useCloudAccount(bridge);
  const [asked, setAsked] = useState<boolean | null>(null);
  const [opened, setOpened] = useState(false);
  const [declined, setDeclined] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.offer().then((offer) => { if (live) setAsked(offer.due); }).catch(() => { if (live) setAsked(false); });
    return () => { live = false; };
  }, [bridge]);
  const status = offerStatus({ bridge: Boolean(bridge), asked, card: account ? cloudCard(account).kind : null, failed });
  useEffect(() => { if (status === "due") setOpened(true); }, [status]);
  const open = opened && !declined;
  return {
    bridge, account, accept, open,
    holding: !declined && (open || status === "checking" || status === "due"),
    decline: () => { setDeclined(true); void bridge?.declineOffer().catch(() => {}); },
  };
}

function useSlow(active: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) { setSlow(false); return; }
    const timer = setTimeout(() => setSlow(true), SLOW_OPENING_MS);
    return () => clearTimeout(timer);
  }, [active]);
  return slow;
}

function AfterSignIn({ account, onContinue }: { account: CloudAccountState; onContinue: () => void }) {
  const line = gateLine(cloudCard(account));
  const slow = useSlow(line?.kind === "opening");
  if (!line) return null;
  const text = line.kind === "opening" ? t("cloudSignIn.opening")
    : line.kind === "setting-up" ? t(line.slow ? "cloudSignIn.settingUpSlow" : "cloudSignIn.settingUp") : t(line.note);
  return (
    <div data-cloud-sign-in-after={line.kind} className="flex flex-col items-center gap-3 text-center">
      <p role="status" className="text-[14px] leading-relaxed text-ink-secondary">{text}</p>
      {(line.kind === "stuck" || slow) && <QuietButton type="button" onClick={onContinue}>{t("cloudSignIn.continueHere")}</QuietButton>}
    </div>
  );
}

export function CloudSignInGate({ gate }: { gate: CloudSignInGateHandle }) {
  const { bridge, account, accept, open, decline } = gate;
  const signedIn = account ? cloudCard(account).kind === "signed-in" : false;
  if (!bridge || !open) return null;
  return (
    <div data-cloud-sign-in-gate className="fixed inset-0 z-[60] flex items-center justify-center bg-app p-3 sm:p-8">
      <div role="dialog" aria-modal="true" aria-label={brand().name}
        className="welcome-card flex max-h-full w-full flex-col gap-5 overflow-y-auto rounded-2xl border border-hairline/40 bg-panel p-5 shadow-[0_30px_80px_-28px_rgba(0,0,0,0.45),0_8px_24px_-12px_rgba(0,0,0,0.25)] sm:p-8"
        style={{ maxWidth: 420 }}>
        <div className="flex flex-col items-center gap-3">
          <DogAvatar color="yellow" state="happy" motion="blink" motionKey={0} size={72} label={brand().name} />
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">{brand().name}</h1>
        </div>
        {signedIn && account
          ? <AfterSignIn account={account} onContinue={decline} />
          : <CloudSignInForm bridge={bridge} onSignedIn={accept} onSkip={decline} intro={t("cloudSignIn.tagline")} />}
      </div>
    </div>
  );
}
