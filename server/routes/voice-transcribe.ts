import type { IncomingMessage } from "node:http";
import { serverTiming, type TranscribeAnswer } from "../laterdog/transcribe.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface VoiceTranscribeRouteDeps {
  transcribe(req: IncomingMessage, url: URL): Promise<TranscribeAnswer>;
}

export function createVoiceTranscribeRoutes(deps: VoiceTranscribeRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, json }) => {
    if (method !== "POST" || path !== "/api/voice/transcribe") return PASS;
    const { status, body, timings } = await deps.transcribe(req, url);
    if (timings) {
      res.setHeader("server-timing", serverTiming(timings));
      console.info(`[voice] transcribed ${req.headers["content-length"] ?? "?"} bytes: read ${timings.readMs} ms, service ${timings.serviceMs} ms, answered ${status}`);
    }
    return json(res, status, body);
  };
}
