import { useState } from "react";
import { PROGRESS_AFTER_MS } from "@/lib/outbox";
import { t } from "@/lib/i18n";

export function SendingTrack({ at }: { at: number }) {
  const [wait] = useState(() => Math.max(0, PROGRESS_AFTER_MS - (Date.now() - at)));
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
