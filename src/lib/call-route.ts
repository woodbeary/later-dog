import { t } from "./i18n";

export type CallRoute =
  | { kind: "turns" }
  | { kind: "live" }
  | { kind: "checking" }
  | { kind: "unavailable"; reason: string; needsVoice: boolean };

export interface CallRouteInput {
  capabilitiesReady: boolean;
  speechMissing: string | null;
  voiceReady: boolean;
  liveConfigured: boolean;
  name: string;
}

export function callVoiceReady(tts: { configured?: boolean; ready?: boolean } | undefined, botVoice: string | undefined): boolean {
  return Boolean(tts?.configured) && Boolean(tts?.ready || botVoice);
}

export function callRoute({ capabilitiesReady, speechMissing, voiceReady, liveConfigured, name }: CallRouteInput): CallRoute {
  if (!capabilitiesReady) return { kind: "checking" };
  if (!speechMissing && voiceReady) return { kind: "turns" };
  if (liveConfigured) return { kind: "live" };
  if (speechMissing) return { kind: "unavailable", reason: speechMissing, needsVoice: false };
  return { kind: "unavailable", reason: t("call.unavailable.noVoice", { name }), needsVoice: true };
}
