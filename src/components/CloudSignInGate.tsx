import { useEffect, useState } from "react";
import type { CloudAccountBridge, CloudAccountState } from "../../electron/cloud-account.mjs";
import { DogAvatar } from "@/components/Avatar";
import { CloudSignInForm } from "@/components/CloudSignInForm";
import { brand } from "@/lib/brand";
import { cloudAccountBridge, cloudCard, useCloudAccount } from "@/lib/cloud-account-view";
import { offerStatus } from "@/lib/cloud-sign-in-view";
import { t } from "@/lib/i18n";

export interface CloudSignInGateHandle {
  bridge: CloudAccountBridge | undefined;
  account: CloudAccountState | null;
  accept: (next: CloudAccountState) => void;
  open: boolean;
  holding: boolean;
  decline: () => void;
}

export function useCloudSignInGate(): CloudSignInGateHandle {
  const bridge = window.laterdog?.localPage === true ? cloudAccountBridge() : undefined;
  const { account, failed, accept } = useCloudAccount(bridge);
  const [asked, setAsked] = useState<boolean | null>(null);
  const [opened, setOpened] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [completed, setCompleted] = useState(false);
  const confirmed = account?.status === "connected" && Boolean(account.account);
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.offer().then((offer) => { if (live) setAsked(offer.due); }).catch(() => { if (live) setAsked(false); });
    return () => { live = false; };
  }, [bridge]);
  const status = offerStatus({ bridge: Boolean(bridge), asked, card: account ? cloudCard(account).kind : null, failed });
  useEffect(() => { if (confirmed) setCompleted(true); }, [confirmed]);
  useEffect(() => { if (status === "due") setOpened(true); }, [status]);
  const finished = declined || completed || confirmed;
  const open = opened && !finished;
  return {
    bridge, account, open,
    accept: (next) => {
      accept(next);
      if (next.account) setCompleted(true);
    },
    holding: !finished && (open || status === "checking" || status === "due"),
    decline: () => { setDeclined(true); void bridge?.declineOffer().catch(() => {}); },
  };
}

export function CloudSignInGate({ gate }: { gate: CloudSignInGateHandle }) {
  const { bridge, accept, open, decline } = gate;
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
        <CloudSignInForm bridge={bridge} onSignedIn={accept} onSkip={decline} intro={t("cloudSignIn.tagline")} />
      </div>
    </div>
  );
}
