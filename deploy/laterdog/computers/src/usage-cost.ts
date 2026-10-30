import type { TokenUsage } from "./ai";

export type Provider = "elevenlabs" | "cloudflare" | "xai" | "anthropic";
export type Service = "dictation" | "voice" | "chat" | "typing" | "decisions";
export type Spend = { service: Service; provider: Provider; units: number; micros: number };

export const PROVIDERS: readonly Provider[] = ["elevenlabs", "cloudflare", "xai", "anthropic"];
export const SERVICES: readonly Service[] = ["dictation", "voice", "chat", "typing", "decisions"];

export type DictationEngine = "elevenlabs" | "nova-3" | "whisper";
export type VoiceEngine = "elevenlabs" | "aura";
export type ChatSource = "anthropic" | "grok" | "workers";

const DICTATION: Record<DictationEngine, { provider: Provider; microsPerSecond: number }> = {
  elevenlabs: { provider: "elevenlabs", microsPerSecond: 220_000 / 3_600 },
  "nova-3": { provider: "cloudflare", microsPerSecond: 5_200 / 60 },
  whisper: { provider: "cloudflare", microsPerSecond: 500 / 60 },
};

const VOICE: Record<VoiceEngine, { provider: Provider; microsPerChar: number }> = {
  elevenlabs: { provider: "elevenlabs", microsPerChar: 50 },
  aura: { provider: "cloudflare", microsPerChar: 30 },
};

const CHAT: Record<ChatSource, { provider: Provider; input: number; output: number }> = {
  anthropic: { provider: "anthropic", input: 0.1, output: 0.5 },
  grok: { provider: "xai", input: 0.2, output: 0.5 },
  workers: { provider: "cloudflare", input: 0.95, output: 4 },
};

const CALL: Record<"typing" | "decisions", { provider: Provider; micros: number }> = {
  typing: { provider: "cloudflare", micros: 28 },
  decisions: { provider: "cloudflare", micros: 480 },
};

const whole = (value: number) => (Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0);

export function dictationSpend(engine: DictationEngine, seconds: number): Spend | null {
  const units = whole(seconds);
  const price = DICTATION[engine];
  return units > 0 ? { service: "dictation", provider: price.provider, units, micros: Math.round(units * price.microsPerSecond) } : null;
}

export function voiceSpend(engine: VoiceEngine, chars: number): Spend | null {
  const units = whole(chars);
  const price = VOICE[engine];
  return units > 0 ? { service: "voice", provider: price.provider, units, micros: Math.round(units * price.microsPerChar) } : null;
}

export function chatSpend(source: ChatSource, usage: TokenUsage): Spend | null {
  const units = whole(usage.total);
  if (units === 0) return null;
  const output = Math.min(units, whole(usage.output));
  const price = CHAT[source];
  return { service: "chat", provider: price.provider, units, micros: Math.round((units - output) * price.input + output * price.output) };
}

export function callSpend(service: "typing" | "decisions"): Spend {
  const price = CALL[service];
  return { service, provider: price.provider, units: 1, micros: price.micros };
}

export function isSpend(value: unknown): value is Spend {
  if (!value || typeof value !== "object") return false;
  const spend = value as Partial<Spend>;
  return (SERVICES as readonly unknown[]).includes(spend.service)
    && (PROVIDERS as readonly unknown[]).includes(spend.provider)
    && typeof spend.units === "number" && Number.isFinite(spend.units) && spend.units >= 0
    && typeof spend.micros === "number" && Number.isFinite(spend.micros) && spend.micros >= 0;
}
