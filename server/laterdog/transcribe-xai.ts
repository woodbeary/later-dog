import type { ServiceCredential } from "../included-services.ts";
import type { Transcription } from "./transcribe.ts";

export const XAI_API_DEFAULT = "https://api.x.ai/v1";
const XAI_TIMEOUT_MS = 60_000;

export interface XaiVoice {
  kind: "xai";
  token: string;
  api: string;
  included: false;
}

export type Transcriber = ServiceCredential | XaiVoice;

export function xaiVoice(key: string | undefined, api: string = XAI_API_DEFAULT): XaiVoice | null {
  const token = key?.trim();
  return token ? { kind: "xai", token, api: api.replace(/\/+$/, ""), included: false } : null;
}

export function pickTranscriber(voice: ServiceCredential | null, xai: XaiVoice | null): Transcriber | null {
  if (voice && !voice.included) return voice;
  return xai ?? voice;
}

export const isXaiVoice = (service: Transcriber): service is XaiVoice => "kind" in service && service.kind === "xai";

function theirWords(body: any): string {
  const said =
    (typeof body?.error === "string" && body.error) ||
    (typeof body?.error?.message === "string" && body.error.message) ||
    (typeof body?.message === "string" && body.message) ||
    "";
  return said.trim();
}

function xaiFailure(status: number, body: unknown): string {
  if (status === 401 || status === 403) return "xAI refused this key for speech to text. Check the xAI key in Settings.";
  const theirs = theirWords(body);
  if (status === 429) return theirs || "xAI is rate-limiting this key. Wait a moment and try again.";
  return theirs ? `Transcription failed: ${theirs}` : `Transcription failed (${status}).`;
}

export async function transcribeWithXai(
  audio: Uint8Array,
  voice: XaiVoice,
  language?: string,
  fetcher: typeof fetch = fetch,
): Promise<Transcription> {
  const form = new FormData();
  if (language) form.append("language", language);
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "voice-note.wav");
  let res: Response;
  try {
    res = await fetcher(`${voice.api}/stt`, {
      method: "POST",
      headers: { authorization: `Bearer ${voice.token}` },
      body: form,
      signal: AbortSignal.timeout(XAI_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Couldn't reach xAI to transcribe. Check your connection.");
  }
  const body: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(xaiFailure(res.status, body));
  if (typeof body?.text !== "string") throw new Error("The transcription came back without text.");
  return { text: body.text.trim(), language: typeof body.language === "string" && body.language ? body.language : null };
}
