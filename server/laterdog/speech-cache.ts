import { createHash } from "node:crypto";

export interface SpeechClip {
  bytes: Uint8Array;
  mime: string;
}

export interface SpeechCacheLimits {
  maxEntries: number;
  maxBytes: number;
}

export const SPEECH_CACHE_LIMITS: SpeechCacheLimits = { maxEntries: 32, maxBytes: 8 * 1024 * 1024 };

export interface SpeechKeyParts {
  provider: string;
  voice: string;
  model: string;
  text: string;
}

export function speechCacheKey(parts: SpeechKeyParts): string {
  return createHash("sha256")
    .update(JSON.stringify([parts.provider, parts.voice, parts.model, parts.text]))
    .digest("hex");
}

export class SpeechCache {
  private readonly clips = new Map<string, SpeechClip>();
  private readonly pending = new Map<string, Promise<SpeechClip>>();
  private held = 0;
  private readonly limits: SpeechCacheLimits;

  constructor(limits: SpeechCacheLimits = SPEECH_CACHE_LIMITS) {
    this.limits = limits;
  }

  get entries(): number {
    return this.clips.size;
  }

  get bytes(): number {
    return this.held;
  }

  speak(key: string, synthesize: () => Promise<SpeechClip>): Promise<SpeechClip> {
    const hit = this.clips.get(key);
    if (hit) {
      this.clips.delete(key);
      this.clips.set(key, hit);
      return Promise.resolve(hit);
    }
    const running = this.pending.get(key);
    if (running) return running;
    const run = synthesize()
      .then((clip) => {
        this.keep(key, clip);
        return clip;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, run);
    return run;
  }

  clear(): void {
    this.clips.clear();
    this.held = 0;
  }

  private keep(key: string, clip: SpeechClip): void {
    const size = clip.bytes.byteLength;
    if (size === 0 || size > this.limits.maxBytes || this.limits.maxEntries <= 0) return;
    const previous = this.clips.get(key);
    if (previous) {
      this.held -= previous.bytes.byteLength;
      this.clips.delete(key);
    }
    this.clips.set(key, clip);
    this.held += size;
    while (this.clips.size > this.limits.maxEntries || this.held > this.limits.maxBytes) {
      const oldest = this.clips.keys().next().value!;
      this.held -= this.clips.get(oldest)!.bytes.byteLength;
      this.clips.delete(oldest);
    }
  }
}

export interface SpeechVoiceSettings {
  voice?: string;
  model?: string;
  fishModel?: string;
  baseUrl?: string;
}

export function configuredSpeechKey(provider: string, settings: SpeechVoiceSettings | undefined, text: string, voiceId?: string): string {
  return speechCacheKey({
    provider,
    voice: voiceId || settings?.voice || "",
    model: [settings?.model ?? "", settings?.fishModel ?? "", settings?.baseUrl ?? ""].join("|"),
    text,
  });
}
