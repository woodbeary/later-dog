const TRANSCRIBE_TIMEOUT_MS = 45_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const RETRY_STATUSES = new Set([502, 503, 504]);
const ALIASES: Record<string, string> = { nb: "no", fil: "tl", iw: "he", in: "id", ji: "yi" };

export interface VoiceNoteAudio {
  speechAudio?(file: string): Promise<Uint8Array<ArrayBuffer> | null>;
}

export function dictationLanguage(locale: string | undefined): string | undefined {
  const base = locale?.split(/[-_]/)[0]?.toLowerCase() ?? "";
  const code = ALIASES[base] ?? base;
  return /^[a-z]{2}$/.test(code) ? code : undefined;
}

export type SharperOutcome = { text: string } | { miss: "no-audio" | "no-service" | "off" | "failed" };
export type Pause = (ms: number) => Promise<void>;

const wait: Pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function transcribeOnce(
  audio: Uint8Array<ArrayBuffer>,
  language: string | undefined,
  fetcher: typeof fetch,
): Promise<SharperOutcome | "again"> {
  try {
    const res = await fetcher(`/api/voice/transcribe${language ? `?language=${language}` : ""}`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: audio,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      if (RETRY_STATUSES.has(res.status)) return "again";
      const reason = body && typeof body === "object" && "reason" in body ? body.reason : undefined;
      return { miss: reason === "no-service" ? "no-service" : reason === "off" ? "off" : "failed" };
    }
    const text = body && typeof body === "object" && "text" in body && typeof body.text === "string" ? body.text.trim() : "";
    return text ? { text } : { miss: "failed" };
  } catch (error) {
    return error instanceof DOMException && error.name === "TimeoutError" ? { miss: "failed" } : "again";
  }
}

export async function transcribeDictation(
  audio: Uint8Array<ArrayBuffer>,
  locale: string | undefined,
  fetcher: typeof fetch = fetch,
  pause: Pause = wait,
): Promise<SharperOutcome> {
  if (!audio.byteLength) return { miss: "no-audio" };
  const language = dictationLanguage(locale);
  for (const delay of [...RETRY_DELAYS_MS, null]) {
    const outcome = await transcribeOnce(audio, language, fetcher);
    if (outcome !== "again") return outcome;
    if (delay === null) break;
    await pause(delay);
  }
  return { miss: "failed" };
}

export async function sharperTranscriptOutcome(
  recording: string,
  bridge: VoiceNoteAudio | undefined,
  locale: string | undefined,
  fetcher: typeof fetch = fetch,
  pause: Pause = wait,
): Promise<SharperOutcome> {
  let audio: Uint8Array<ArrayBuffer> | null | undefined;
  try {
    audio = await bridge?.speechAudio?.(recording);
  } catch {
    return { miss: "failed" };
  }
  if (!audio?.byteLength) return { miss: "no-audio" };
  return transcribeDictation(audio, locale, fetcher, pause);
}

export async function sharperTranscript(
  recording: string,
  bridge: VoiceNoteAudio | undefined,
  locale: string | undefined,
  fetcher: typeof fetch = fetch,
  pause: Pause = wait,
): Promise<string | null> {
  const outcome = await sharperTranscriptOutcome(recording, bridge, locale, fetcher, pause);
  return "text" in outcome ? outcome.text : null;
}
