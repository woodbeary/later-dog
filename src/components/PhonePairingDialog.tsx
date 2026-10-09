// "Connect your phone", from the profile menu: the same pairing flow the
// welcome tour offers, in a dialog of its own. Settings has no Remote access
// page any more, so after the tour this is where a phone gets paired.
import { useEffect } from "react";
import { X } from "lucide-react";

import { t } from "@/lib/i18n";
import { PhoneSetupFlow } from "./PhoneSetupFlow";

export function PhonePairingDialog({ open, onClose, profileEmail }: { open: boolean; onClose: () => void; profileEmail?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

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
        <PhoneSetupFlow variant="settings" profileEmail={profileEmail} onComplete={onClose} />
      </div>
    </div>
  );
}
