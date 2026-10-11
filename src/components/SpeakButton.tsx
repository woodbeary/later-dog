import { Loader2, Square } from "lucide-react";

import { speaker } from "@/lib/tts";
import type { ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { messageActionClass } from "./MessageActions";

export function canSpeak(tts: ConfigStatus["tts"], voiceId: string | undefined, localVoice: boolean): boolean {
  return localVoice || (Boolean(tts?.configured) && Boolean(voiceId || tts?.voice));
}

export function StopSpeakingButton({ preparing }: { preparing: boolean }) {
  return (
    <button
      type="button"
      onClick={() => speaker.stop()}
      aria-label={t("chat.speak.stop")}
      title={t("chat.speak.stop")}
      className={cn(messageActionClass, "text-accent")}
    >
      {preparing ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} className="fill-current" />}
    </button>
  );
}
