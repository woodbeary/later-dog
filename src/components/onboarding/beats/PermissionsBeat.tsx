import { useEffect } from "react";
import { PermissionChecklist } from "@/components/PermissionChecklist";
import { allGranted, checklistHost } from "@/lib/desktop-permissions";
import { t } from "@/lib/i18n";
import { useDesktopPermissions } from "@/lib/use-desktop-permissions";
import { PrimaryButton, QuietButton, type BeatProps } from "./shared";

export function PermissionsBeat({ onNext, onSkip, setMascot, bump }: BeatProps) {
  const host = checklistHost(window.laterdog);
  const { checklist, busy, request, openSettings } = useDesktopPermissions({ active: host === "mac" });

  useEffect(() => {
    setMascot("listening");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const granted = host === "mac" && allGranted(checklist);
  useEffect(() => {
    if (granted) bump("success");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [granted]);

  return (
    <div className="flex flex-col">
      <p className="animate-rise mt-1 text-[13.5px] text-ink-secondary">{t("onboarding.perms.intro")}</p>
      <div className="mt-4">
        <PermissionChecklist
          host={host}
          checklist={checklist}
          busy={busy}
          onRequest={(permission) => void request(permission)}
          onOpenSettings={(permission) => void openSettings(permission)}
          stagger
        />
      </div>
      <PrimaryButton onClick={onNext} className="mt-5">
        {t("onboarding.continue")}
      </PrimaryButton>
      <QuietButton onClick={onSkip} className="mt-3 self-center">
        {t("onboarding.skip")}
      </QuietButton>
    </div>
  );
}
