import { useEffect, useRef } from "react";
import { X } from "lucide-react";

import { t } from "@/lib/i18n";
import type { PhonePairingTarget } from "@/lib/phone-pairing";
import { PairedPhones } from "./PairedPhones";
import { PhoneSetupFlowView, usePhoneSetupController } from "./PhoneSetupFlow";
import { ServerPairingCard } from "./ServerPairingCard";

export function PhonePairingDialog({ open, onClose, profileEmail, target = "computer", initialRoute }: { open: boolean; onClose: () => void; profileEmail?: string; target?: PhonePairingTarget; initialRoute?: "local" }) {
  if (!open) return null;
  return <OpenPhonePairingDialog onClose={onClose} profileEmail={profileEmail} target={target} initialRoute={initialRoute} />;
}

function OpenPhonePairingDialog({ onClose, profileEmail, target, initialRoute }: { onClose: () => void; profileEmail?: string; target: PhonePairingTarget; initialRoute?: "local" }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("sidebar.menu.connectPhone")}
        data-phone-pairing-dialog=""
        className="relative max-h-full w-full max-w-[520px] overflow-y-auto rounded-2xl border border-hairline/50 bg-panel p-6 shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          title={t("common.close")}
          className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={16} />
        </button>
        {target === "computer"
          ? <ComputerPairing onClose={onClose} profileEmail={profileEmail} initialRoute={initialRoute} />
          : <ServerPairingCard cloudHome={target === "cloud"} />}
      </div>
    </div>
  );
}

function ComputerPairing({ onClose, profileEmail, initialRoute }: { onClose: () => void; profileEmail?: string; initialRoute?: "local" }) {
  const controller = usePhoneSetupController(profileEmail);
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !initialRoute || !controller.state || controller.busy || controller.accountBusy) return;
    started.current = true;
    controller.useLocal();
  }, [initialRoute, controller.state, controller.busy, controller.accountBusy, controller.useLocal]);
  return (
    <>
      <PhoneSetupFlowView controller={initialRoute === "local" ? { ...controller, start: controller.useLocal } : controller} variant="settings" onComplete={onClose} />
      {controller.phase === "intro" && <PairedPhones controller={controller} />}
    </>
  );
}
