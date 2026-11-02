import { readAudio } from "../laterdog/transcribe.ts";
import type { Transcriber } from "../laterdog/transcribe-xai.ts";
import { serviceTranscriber, type createVoiceStreams } from "../laterdog/voice-stream.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const VOICE_STREAM_TYPE = "audio/x-ima-adpcm";
const PATH = "/api/voice/stream";
const CHUNK_MAX_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9-]{8,64}$/;
const LANGUAGE = /^[a-z]{2}$/;

export interface VoiceStreamRouteDeps {
  streams: ReturnType<typeof createVoiceStreams>;
  enabled(): boolean;
  transcriber(): Transcriber | null;
  fetcher?: typeof fetch;
}

export function createVoiceStreamRoutes(deps: VoiceStreamRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, json }) => {
    if (path !== PATH || (method !== "POST" && method !== "DELETE")) return PASS;
    const id = url.searchParams.get("id") ?? "";
    const refuse = (status: number, error: string, reason?: string) => {
      req.resume();
      return json(res, status, { error, ...(reason ? { reason } : {}) });
    };
    if (!ID.test(id)) return refuse(400, "Name the dictation with an id.");
    if (method === "DELETE") {
      deps.streams.drop(id);
      req.resume();
      return json(res, 200, { ok: true });
    }
    if (!deps.enabled()) return refuse(409, "Sharper dictation is turned off.", "off");
    const service = deps.transcriber();
    if (!service) return refuse(409, "No transcription service is set up. Add an ElevenLabs or xAI key, or start the free trial.", "no-service");
    const type = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (type !== VOICE_STREAM_TYPE) return refuse(415, `Send the voice note as ${VOICE_STREAM_TYPE}.`);
    const seq = Number(url.searchParams.get("seq"));
    if (!Number.isInteger(seq) || seq < 0) return refuse(400, "Number each part of the dictation.");
    const language = url.searchParams.get("language")?.trim().toLowerCase() ?? "";
    if (language && !LANGUAGE.test(language)) return refuse(400, "Name the language with a two-letter code, or leave it out.");
    const final = url.searchParams.get("final") === "1";
    const readStarted = performance.now();
    const audio = await readAudio(req, CHUNK_MAX_BYTES);
    const readMs = Math.round(performance.now() - readStarted);
    if (audio === "too-large") return json(res, 413, { error: "That part of the dictation is too large." });
    const answer = await deps.streams.add(id, seq, new Uint8Array(audio), final, serviceTranscriber(service, deps.fetcher), language || undefined);
    if (!answer.ok) return json(res, answer.status, { error: answer.error });
    if (!answer.done) return json(res, 200, { ok: true });
    const { pieces, waitMs, tailMs } = answer.timings;
    res.setHeader("server-timing", `read;dur=${readMs}, wait;dur=${waitMs}, tail;dur=${tailMs}`);
    console.info(`[voice] streamed dictation in ${pieces} pieces: last part read ${readMs} ms, waited ${waitMs} ms after it, last piece ${tailMs} ms`);
    return json(res, 200, { text: answer.text, pieces, included: service.included });
  };
}
