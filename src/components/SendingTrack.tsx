import { useState } from "react";
import { PROGRESS_AFTER_MS } from "@/lib/outbox";
import { t } from "@/lib/i18n";

export function SendingTrack({ at, held = false }: { at: number; held?: boolean }) {
  const [wait] = useState(() => Math.max(0, PROGRESS_AFTER_MS - (Date.now() - at)));
  if (held) {
    return <div data-send-held role="status" className="mt-1 pr-1 text-[11px] text-ink-tertiary">{t("chat.queued.waiting")}</div>;
  }
  return (
    <div
      data-sending-track
      role="status"
      aria-label={t("chat.sending")}
      className="sending-track mt-1 h-[2px] w-12 overflow-hidden rounded-full bg-ink-tertiary/25"
      style={{ animationDelay: `${wait}ms` }}
    >
      <div className="sending-track-bar h-full w-1/3 rounded-full bg-ink-tertiary" />
    </div>
  );
}
