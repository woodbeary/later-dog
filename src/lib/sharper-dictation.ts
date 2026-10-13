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

export async function sharperTranscript(
  recording: string,
  bridge: VoiceNoteAudio | undefined,
  locale: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const audio = await bridge?.speechAudio?.(recording);
    if (!audio?.byteLength) return null;
    const language = dictationLanguage(locale);
    const res = await fetcher(`/api/voice/transcribe${language ? `?language=${language}` : ""}`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: audio,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const text = body && typeof body === "object" && "text" in body && typeof body.text === "string" ? body.text.trim() : "";
    return text || null;
  } catch {
    return null;
  }
}
