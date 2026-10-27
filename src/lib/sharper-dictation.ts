const TRANSCRIBE_TIMEOUT_MS = 45_000;
const ALIASES: Record<string, string> = { nb: "no", fil: "tl", iw: "he", in: "id", ji: "yi" };

export interface VoiceNoteAudio {
  speechAudio?(file: string): Promise<Uint8Array<ArrayBuffer> | null>;
}

export function dictationLanguage(locale: string | undefined): string | undefined {
  const base = locale?.split(/[-_]/)[0]?.toLowerCase() ?? "";
  const code = ALIASES[base] ?? base;
  return /^[a-z]{2}$/.test(code) ? code : undefined;
}

export type SharperOutcome = { text: string } | { miss: "no-audio" | "no-service" | "failed" };

export async function sharperTranscriptOutcome(
  recording: string,
  bridge: VoiceNoteAudio | undefined,
  locale: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<SharperOutcome> {
  try {
    const audio = await bridge?.speechAudio?.(recording);
    if (!audio?.byteLength) return { miss: "no-audio" };
    const language = dictationLanguage(locale);
    const res = await fetcher(`/api/voice/transcribe${language ? `?language=${language}` : ""}`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: audio,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const reason = body && typeof body === "object" && "reason" in body ? body.reason : undefined;
      return { miss: reason === "no-service" ? "no-service" : "failed" };
    }
    const text = body && typeof body === "object" && "text" in body && typeof body.text === "string" ? body.text.trim() : "";
    return text ? { text } : { miss: "failed" };
  } catch {
    return { miss: "failed" };
  }
}

export async function sharperTranscript(
  recording: string,
  bridge: VoiceNoteAudio | undefined,
  locale: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const outcome = await sharperTranscriptOutcome(recording, bridge, locale, fetcher);
  return "text" in outcome ? outcome.text : null;
}
