// Beat: what this computer may let a bot do. One row per macOS grant — the
// microphone for dictation, Accessibility so a bot can click and type here,
// Screen Recording so it can see the screen — each read live from the
// desktop bridge, with the real system prompt behind Enable and System
// Settings behind the link macOS leaves after a denial. Screen Recording's
// status is what macOS caches for this process (electron/mac-permissions.mjs),
// so that row says a grant made in System Settings shows after a relaunch.
// Without the bridge (a browser, the preview page) the rows say the desktop
// app has them. Settings → Computers → Permissions shows the same rows again,
// so skipping here loses nothing.
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
