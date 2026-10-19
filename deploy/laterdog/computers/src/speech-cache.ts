import { sha256Hex } from "./auth";

export const SPEECH_CACHE_SECONDS = 30 * 24 * 60 * 60;
export const SPEECH_CACHE_PATH = "/__speech-cache/";

export interface SpeechStore {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export type SpeechKey = { engine: string; voice: string; format: string; text: string };

export type Audio = Uint8Array | ReadableStream<Uint8Array>;

export function speechDigest(key: SpeechKey): Promise<string> {
  return sha256Hex([key.engine, key.voice, key.format, key.text].join("|"));
}

export function edgeSpeechStore(): SpeechStore | null {
  const storage = (globalThis as { caches?: { default?: SpeechStore } }).caches;
  return storage?.default ?? null;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class SpeechCache {
  constructor(
    private readonly store: SpeechStore | null,
    private readonly origin: string,
    private readonly waitUntil: (work: Promise<unknown>) => void,
  ) {}

  private async address(key: SpeechKey): Promise<Request> {
    return new Request(new URL(`${SPEECH_CACHE_PATH}${await speechDigest(key)}`, this.origin));
  }

  async find(key: SpeechKey): Promise<ReadableStream<Uint8Array> | null> {
    if (!this.store) return null;
    try {
      const hit = await this.store.match(await this.address(key));
      if (hit?.ok && hit.body) return hit.body;
      await hit?.body?.cancel().catch(() => {});
    } catch (error) {
      console.error(`laterdog computers: speech cache read failed: ${describe(error)}`);
    }
    return null;
  }

  keep(key: SpeechKey, audio: Audio): void {
    const store = this.store;
    if (!store) {
      if (audio instanceof ReadableStream) void audio.cancel().catch(() => {});
      return;
    }
    const headers = { "content-type": "audio/mpeg", "cache-control": `public, max-age=${SPEECH_CACHE_SECONDS}` };
    const stored = this.address(key).then((address) => store.put(address, new Response(audio, { headers })));
    this.waitUntil(stored.catch((error: unknown) => console.error(`laterdog computers: speech cache write failed: ${describe(error)}`)));
  }
}
