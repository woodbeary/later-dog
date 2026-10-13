import type { IncomingMessage } from "node:http";
import type { ServiceCredential } from "../included-services.ts";

export const TRANSCRIBE_MAX_BYTES = 10 * 1024 * 1024;
export const TRANSCRIBE_MODEL = "scribe_v2";
const TRANSCRIBE_TIMEOUT_MS = 60_000;
const LANGUAGE = /^[a-z]{2}$/;
const WAV_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/wave"]);

export interface Transcription {
  text: string;
  language: string | null;
}

export interface TranscribeAnswer {
  status: number;
  body: Record<string, unknown>;
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export function readAudio(req: IncomingMessage, limit = TRANSCRIBE_MAX_BYTES): Promise<Buffer | "too-large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      received += chunk.byteLength;
      if (received <= limit) return void chunks.push(chunk);
      settled = true;
      chunks.length = 0;
      resolve("too-large");
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function theirMessage(body: any): string {
  const said =
    (typeof body?.error?.message === "string" && body.error.message) ||
    (typeof body?.detail === "string" && body.detail) ||
    (typeof body?.detail?.message === "string" && body.detail.message) ||
    (typeof body?.message === "string" && body.message) ||
    "";
  return said.trim();
}

function failure(status: number, body: any, included: boolean): string {
  const theirs = theirMessage(body);
  if (included) return theirs || `The included transcription did not answer (${status}).`;
  if (status === 401 || status === 403) return "ElevenLabs refused this key for speech to text. If it's a restricted key, give it the Speech to Text permission.";
  if (status === 429) return theirs || "ElevenLabs is rate-limiting this account. Wait a moment and try again.";
  if (status === 402) return theirs || "ElevenLabs says this account is out of credit.";
  return theirs ? `Transcription failed: ${theirs}` : `Transcription failed (${status}).`;
}

export async function transcribeAudio(
  audio: Uint8Array,
  credential: ServiceCredential,
  language?: string,
  fetcher: typeof fetch = fetch,
): Promise<Transcription> {
  const form = new FormData();
  form.append("model_id", TRANSCRIBE_MODEL);
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "voice-note.wav");
  form.append("tag_audio_events", "false");
  form.append("timestamps_granularity", "none");
  if (language) form.append("language_code", language);
  let res: Response;
  try {
    res = await fetcher(`${credential.api}/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": credential.token },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
  } catch {
    throw new Error(credential.included ? "Couldn't reach the included transcription." : "Couldn't reach ElevenLabs to transcribe. Check your connection.");
  }
  const body = await safeJson(res);
  if (!res.ok) throw new Error(failure(res.status, body, credential.included));
  if (typeof body?.text !== "string") throw new Error("The transcription came back without text.");
  return { text: body.text.trim(), language: typeof body.language_code === "string" ? body.language_code : null };
}

export async function transcribeRoute(
  req: IncomingMessage,
  url: URL,
  enabled: boolean,
  credential: ServiceCredential | null,
  fetcher: typeof fetch = fetch,
): Promise<TranscribeAnswer> {
  const refuse = (status: number, error: string, reason?: string): TranscribeAnswer => {
    req.resume();
    return { status, body: { error, ...(reason ? { reason } : {}) } };
  };
  if (!enabled) return refuse(409, "Sharper dictation is turned off.", "off");
  if (!credential) return refuse(409, "No transcription service is set up. Add an ElevenLabs key, or start the free trial.", "no-service");
  const type = first(req.headers["content-type"])?.split(";")[0]?.trim().toLowerCase();
  if (!type || !WAV_TYPES.has(type)) return refuse(415, "Send the voice note as audio/wav.");
  const declared = first(req.headers["content-length"]);
  if (declared !== undefined && Number(declared) > TRANSCRIBE_MAX_BYTES) return refuse(413, "That voice note is too long to transcribe.");
  const language = url.searchParams.get("language")?.trim().toLowerCase() ?? "";
  if (language && !LANGUAGE.test(language)) return refuse(400, "Name the language with a two-letter code, or leave it out.");
  const audio = await readAudio(req);
  if (audio === "too-large") return { status: 413, body: { error: "That voice note is too long to transcribe." } };
  if (audio.byteLength === 0) return { status: 400, body: { error: "The voice note is empty." } };
  try {
    const { text, language: heard } = await transcribeAudio(audio, credential, language || undefined, fetcher);
    return { status: 200, body: { text, ...(heard ? { language: heard } : {}), included: credential.included } };
  } catch (error) {
    return { status: 502, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}
