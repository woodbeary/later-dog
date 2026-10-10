import { useEffect } from "react";
import { X } from "lucide-react";

import { t } from "@/lib/i18n";
import type { PhonePairingTarget } from "@/lib/phone-pairing";
import { PairedPhones } from "./PairedPhones";
import { PhoneSetupFlowView, usePhoneSetupController } from "./PhoneSetupFlow";
import { ServerPairingCard } from "./ServerPairingCard";

export function PhonePairingDialog({ open, onClose, profileEmail, target = "computer" }: { open: boolean; onClose: () => void; profileEmail?: string; target?: PhonePairingTarget }) {
  if (!open) return null;
  return <OpenPhonePairingDialog onClose={onClose} profileEmail={profileEmail} target={target} />;
}

function OpenPhonePairingDialog({ onClose, profileEmail, target }: { onClose: () => void; profileEmail?: string; target: PhonePairingTarget }) {
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
          ? <ComputerPairing onClose={onClose} profileEmail={profileEmail} />
          : <ServerPairingCard cloudHome={target === "cloud"} />}
      </div>
    </div>
  );
}

function ComputerPairing({ onClose, profileEmail }: { onClose: () => void; profileEmail?: string }) {
  const controller = usePhoneSetupController(profileEmail);
  return (
    <>
      <PhoneSetupFlowView controller={controller} variant="settings" onComplete={onClose} />
      {controller.phase === "intro" && <PairedPhones controller={controller} />}
    </>
  );
}
