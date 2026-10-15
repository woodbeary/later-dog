import { useEffect } from "react";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { PhoneSetupFlow } from "./PhoneSetupFlow";

export function PhoneAppDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <OpenPhoneAppDialog onClose={onClose} />;
}

function OpenPhoneAppDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="phone-app-title" data-phone-app-dialog=""
        className="relative max-h-full w-full max-w-[440px] overflow-y-auto rounded-2xl border border-hairline/50 bg-panel p-6 shadow-2xl">
        <button type="button" onClick={onClose} aria-label={t("common.close")} title={t("common.close")}
          className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink">
          <X size={16} />
        </button>
        <PhoneSetupFlow variant="settings" />
      </div>
    </div>
  );
}
