import type { Refusal } from "./auth";

export const VOICE_MODEL = "@cf/deepgram/aura-2-en";
export const VOICE_MAX_CHARS = 2_500;
export const VOICE_CHARS_PER_DAY = 10_000;
export const VOICE_OUTPUT_FORMATS = new Set(["mp3_44100_64", "mp3_44100_128", "mp3_22050_32"]);
export const VOICE_DEFAULT_FORMAT = "mp3_44100_64";

export interface IncludedVoice {
  voice_id: string;
  name: string;
  labels: { accent: string; description: string };
}

export const INCLUDED_VOICES: IncludedVoice[] = [
  { voice_id: "JBFqnCBsd6RMkjVDRZzb", name: "George", labels: { accent: "British", description: "warm" } },
  { voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", labels: { accent: "American", description: "soft" } },
  { voice_id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura", labels: { accent: "American", description: "upbeat" } },
  { voice_id: "IKne3meq5aSn9XLyUdCD", name: "Charlie", labels: { accent: "Australian", description: "casual" } },
  { voice_id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam", labels: { accent: "American", description: "clear" } },
  { voice_id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", labels: { accent: "British", description: "confident" } },
  { voice_id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda", labels: { accent: "American", description: "friendly" } },
  { voice_id: "nPczCjzI2devNBz1zQrb", name: "Brian", labels: { accent: "American", description: "deep" } },
  { voice_id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", labels: { accent: "British", description: "steady" } },
  { voice_id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily", labels: { accent: "British", description: "gentle" } },
];

const VOICE_IDS = new Set(INCLUDED_VOICES.map((voice) => voice.voice_id));

const AURA: Record<string, { speaker: string; accent: string; description: string }> = {
  JBFqnCBsd6RMkjVDRZzb: { speaker: "draco", accent: "British", description: "warm" },
  EXAVITQu4vr4xnSDxMaL: { speaker: "athena", accent: "American", description: "calm" },
  FGY2WhTYpPnrIDTdsKH5: { speaker: "thalia", accent: "American", description: "upbeat" },
  IKne3meq5aSn9XLyUdCD: { speaker: "hyperion", accent: "Australian", description: "warm" },
  TX3LPaxmHKxFdv7VOQHJ: { speaker: "orpheus", accent: "American", description: "clear" },
  Xb7hH8MSUJpSbSDYk0k2: { speaker: "pandora", accent: "British", description: "calm" },
  XrExE9yKIg1WjnnlVkGX: { speaker: "luna", accent: "American", description: "friendly" },
  nPczCjzI2devNBz1zQrb: { speaker: "zeus", accent: "American", description: "deep" },
  onwK4e9ZLuTAKqWW03F9: { speaker: "odysseus", accent: "American", description: "steady" },
  pFZP5JQG7iQjIQuC4Bku: { speaker: "cordelia", accent: "American", description: "gentle" },
};

export function includedVoices(withElevenLabs: boolean): IncludedVoice[] {
  if (withElevenLabs) return INCLUDED_VOICES;
  return INCLUDED_VOICES.map((voice) => {
    const aura = AURA[voice.voice_id]!;
    return { ...voice, labels: { accent: aura.accent, description: aura.description } };
  });
}

export type SpeechRequest = { voiceId: string; text: string; outputFormat: string };

const refuse = (status: number, code: string, message: string): { ok: false; refusal: Refusal } => ({ ok: false, refusal: { status, code, message } });

export function speechRequest(voiceId: string, query: URLSearchParams, body: unknown): { ok: true; request: SpeechRequest } | { ok: false; refusal: Refusal } {
  if (!VOICE_IDS.has(voiceId)) return refuse(404, "voice_not_included", "That voice isn't included. Pick one from the list.");
  const outputFormat = query.get("output_format") ?? VOICE_DEFAULT_FORMAT;
  if (!VOICE_OUTPUT_FORMATS.has(outputFormat)) return refuse(422, "unsupported_format", "That audio format isn't available.");
  const text = body && typeof body === "object" && !Array.isArray(body) ? (body as { text?: unknown }).text : undefined;
  if (typeof text !== "string" || !text.trim()) return refuse(422, "no_text", "Send some text to speak.");
  if (text.length > VOICE_MAX_CHARS) return refuse(413, "too_long", `Send at most ${VOICE_MAX_CHARS} characters at a time.`);
  return { ok: true, request: { voiceId, text, outputFormat } };
}

export const ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";

export function elevenLabsRequest(request: SpeechRequest, key: string) {
  return {
    provider: "elevenlabs",
    endpoint: `v1/text-to-speech/${request.voiceId}?output_format=${request.outputFormat}`,
    headers: {
      "xi-api-key": key,
      "Content-Type": "application/json",
      accept: "audio/mpeg",
      "cf-aig-collect-log": false,
      "cf-aig-request-timeout": 30_000,
    },
    query: { text: request.text, model_id: ELEVENLABS_MODEL_ID },
  };
}

export function voiceInput(request: SpeechRequest) {
  return { text: request.text, speaker: AURA[request.voiceId]?.speaker ?? "draco", encoding: "mp3" };
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export async function audioBytes(raw: unknown, fetcher: typeof fetch = fetch): Promise<Uint8Array | null> {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (raw instanceof ReadableStream || raw instanceof Response) return new Uint8Array(await new Response(raw instanceof Response ? raw.body : raw).arrayBuffer());
  if (!isRecord(raw)) return null;
  const result = isRecord(raw.result) ? raw.result : raw;
  const audio = result.audio;
  if (typeof audio !== "string" || !audio) return null;
  if (audio.startsWith("https://")) {
    const response = await fetcher(audio);
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  }
  try {
    const binary = atob(audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
