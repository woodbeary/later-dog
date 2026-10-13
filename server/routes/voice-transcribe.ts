import type { IncomingMessage } from "node:http";
import type { TranscribeAnswer } from "../laterdog/transcribe.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface VoiceTranscribeRouteDeps {
  transcribe(req: IncomingMessage, url: URL): Promise<TranscribeAnswer>;
}

export function createVoiceTranscribeRoutes(deps: VoiceTranscribeRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, json }) => {
    if (method !== "POST" || path !== "/api/voice/transcribe") return PASS;
    const { status, body } = await deps.transcribe(req, url);
    return json(res, status, body);
  };
}
