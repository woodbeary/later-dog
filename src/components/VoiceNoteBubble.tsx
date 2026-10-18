import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";

import { attachmentAudioUrl } from "@/lib/composer-attachments";
import { t } from "@/lib/i18n";
import { isLiveCallRunning, useLiveMedia } from "@/lib/live-call-media";
import { speaker } from "@/lib/tts";
import { cn } from "@/lib/cn";
import { evenLevels, voiceNoteClock, voiceNoteLevels } from "@/lib/voice-note-levels";
import { whenSeen } from "@/lib/when-seen";

const SEEK_STEP_SECONDS = 5;

export interface VoiceNoteAttachment {
  kind: "audio";
  path: string;
  mime: string;
  durationMs?: number;
}

export function VoiceNoteBubble({
  attachment,
  className,
}: {
  attachment: VoiceNoteAttachment;
  className?: string;
}) {
  const url = attachmentAudioUrl(attachment.path);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState<number | null>(
    typeof attachment.durationMs === "number" && attachment.durationMs > 0
      ? attachment.durationMs / 1000
      : null,
  );
  const [time, setTime] = useState(0);
  const [levels, setLevels] = useState<number[]>(evenLevels);
  const onLiveCall = isLiveCallRunning(useLiveMedia().phase);

  useEffect(() => () => releaseRef.current?.(), []);
  useEffect(() => {
    if (!url) return;
    let current = true;
    const release = whenSeen(rootRef.current, () => {
      void voiceNoteLevels(url).then((measured) => {
        if (current && measured?.length) setLevels(measured);
      });
    });
    return () => {
      current = false;
      release();
    };
  }, [url]);

  if (!url) return null;

  const giveBackVoice = (release?: () => void) => {
    if (release && releaseRef.current !== release) return;
    releaseRef.current?.();
    releaseRef.current = null;
  };

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (onLiveCall) return;
    releaseRef.current?.();
    const release = speaker.claimExternalVoice(() => audio.pause());
    releaseRef.current = release;
    void audio.play().catch(() => giveBackVoice(release));
  };

  const seek = (next: number) => {
    if (!duration || !Number.isFinite(next)) return;
    const clamped = Math.max(0, Math.min(duration, next));
    const audio = audioRef.current;
    if (audio) audio.currentTime = clamped;
    setTime(clamped);
  };
  const progress = duration ? Math.min(1, time / duration) : 0;
  const started = playing || time > 0;

  return (
    <div
      ref={rootRef}
      className={cn("flex w-full items-center gap-3 rounded-xl bg-inset/60 px-3 py-2", className)}
      data-test-voice-note=""
    >
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const loaded = event.currentTarget.duration;
          if (Number.isFinite(loaded) && loaded > 0) setDuration(loaded);
        }}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={(event) => {
          if (!event.currentTarget.paused) return;
          setPlaying(false);
          giveBackVoice();
        }}
        onEnded={() => {
          setPlaying(false);
          giveBackVoice();
        }}
      />
      <button
        type="button"
        onClick={toggle}
        disabled={onLiveCall && !playing}
        aria-label={playing ? t("chat.voiceNote.pause") : onLiveCall ? t("chat.voiceNote.onLiveCall") : t("chat.voiceNote.play")}
        title={playing ? t("chat.voiceNote.pause") : onLiveCall ? t("chat.voiceNote.onLiveCall") : t("chat.voiceNote.play")}
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-app transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {playing ? <Pause size={13} className="fill-current" /> : <Play size={13} className="translate-x-px fill-current" />}
      </button>
      <div
        role="slider"
        tabIndex={duration ? 0 : -1}
        aria-label={t("chat.voiceNote.seek")}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration ?? 0)}
        aria-valuenow={Math.round(Math.min(time, duration ?? time))}
        aria-valuetext={voiceNoteClock(time)}
        aria-disabled={!duration || undefined}
        data-voice-note-bars=""
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          if (duration && box.width > 0) seek(((event.clientX - box.left) / box.width) * duration);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            seek(time + (event.key === "ArrowRight" ? SEEK_STEP_SECONDS : -SEEK_STEP_SECONDS));
          }
        }}
        className="flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-[2px] outline-none focus-visible:ring-1 focus-visible:ring-ink-tertiary aria-disabled:cursor-default"
      >
        {levels.map((level, index) => (
          <span
            key={index}
            aria-hidden="true"
            className={cn("w-[2px] shrink-0 grow rounded-full", (index + 0.5) / levels.length <= progress ? "bg-ink" : "bg-ink-tertiary/60")}
            style={{ height: `${Math.round(level * 100)}%` }}
          />
        ))}
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-ink-secondary" data-voice-note-clock="">
        {voiceNoteClock(started ? time : duration ?? 0)}
      </span>
    </div>
  );
}
