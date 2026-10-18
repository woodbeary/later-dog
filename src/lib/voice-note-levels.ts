export const VOICE_NOTE_BARS = 32;
const QUIET_FLOOR = 0.12;
const CACHE_LIMIT = 64;

export function levelsFromSamples(samples: ArrayLike<number>, bars = VOICE_NOTE_BARS): number[] {
  if (!samples.length || bars <= 0) return [];
  const size = Math.max(1, Math.floor(samples.length / bars));
  const raw: number[] = [];
  for (let bar = 0; bar < bars; bar += 1) {
    const start = bar * size;
    const end = Math.min(samples.length, start + size);
    let sum = 0;
    for (let i = start; i < end; i += 1) sum += samples[i]! * samples[i]!;
    raw.push(end > start ? Math.sqrt(sum / (end - start)) : 0);
  }
  const loudest = Math.max(...raw);
  if (!(loudest > 0)) return raw.map(() => QUIET_FLOOR);
  return raw.map((level) => Math.max(QUIET_FLOOR, Math.min(1, level / loudest)));
}

export function evenLevels(bars = VOICE_NOTE_BARS): number[] {
  return Array.from({ length: bars }, () => QUIET_FLOOR * 2);
}

export function voiceNoteClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

type Decoder = (bytes: ArrayBuffer) => Promise<{ getChannelData(channel: number): Float32Array }>;

function browserDecoder(): Decoder | null {
  const Context = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Context) return null;
  return (bytes) => new Context(1, 1, 44_100).decodeAudioData(bytes);
}

const measured = new Map<string, Promise<number[] | null>>();

export function voiceNoteLevels(
  url: string,
  load: (url: string) => Promise<ArrayBuffer> = (target) => fetch(target).then((response) => {
    if (!response.ok) throw new Error(String(response.status));
    return response.arrayBuffer();
  }),
  decode: Decoder | null = browserDecoder(),
): Promise<number[] | null> {
  const cached = measured.get(url);
  if (cached) return cached;
  if (!decode) return Promise.resolve(null);
  const pending = load(url)
    .then((bytes) => decode(bytes))
    .then((audio) => levelsFromSamples(audio.getChannelData(0)))
    .catch(() => {
      measured.delete(url);
      return null;
    });
  measured.set(url, pending);
  while (measured.size > CACHE_LIMIT) measured.delete(measured.keys().next().value!);
  return pending;
}
