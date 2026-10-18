const LAYER_III_KBPS = {
  mpeg1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  mpeg2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
} as const;
const SAMPLE_RATES = {
  3: [44_100, 48_000, 32_000],
  2: [22_050, 24_000, 16_000],
  0: [11_025, 12_000, 8_000],
} as const;
const HEADER_BYTES = 4;
const ID3_HEADER_BYTES = 10;
const ID3_FOOTER_FLAG = 0x10;

interface Frame {
  bytes: number;
  seconds: number;
}

function id3Length(bytes: Uint8Array, at: number): number {
  if (bytes.length < at + ID3_HEADER_BYTES) return 0;
  if (bytes[at] !== 0x49 || bytes[at + 1] !== 0x44 || bytes[at + 2] !== 0x33) return 0;
  const size = ((bytes[at + 6]! & 0x7f) << 21) | ((bytes[at + 7]! & 0x7f) << 14) | ((bytes[at + 8]! & 0x7f) << 7) | (bytes[at + 9]! & 0x7f);
  const footer = bytes[at + 5]! & ID3_FOOTER_FLAG ? ID3_HEADER_BYTES : 0;
  return ID3_HEADER_BYTES + size + footer;
}

function frameAt(bytes: Uint8Array, at: number): Frame | null {
  if (at + HEADER_BYTES > bytes.length) return null;
  const b1 = bytes[at + 1]!;
  const b2 = bytes[at + 2]!;
  if (bytes[at] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 0b11;
  const layer = (b1 >> 1) & 0b11;
  if (version === 1 || layer !== 0b01) return null;
  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 0b11;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const mpeg1 = version === 3;
  const kbps = (mpeg1 ? LAYER_III_KBPS.mpeg1 : LAYER_III_KBPS.mpeg2)[bitrateIndex]!;
  const sampleRate = SAMPLE_RATES[version as 0 | 2 | 3][rateIndex]!;
  const padding = (b2 >> 1) & 1;
  const samples = mpeg1 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * kbps * 1000) / sampleRate) + padding;
  if (length <= HEADER_BYTES) return null;
  return { bytes: length, seconds: samples / sampleRate };
}

export function mp3DurationMs(input: Uint8Array): number | undefined {
  let at = id3Length(input, 0);
  let seconds = 0;
  let frames = 0;
  let inStep = false;
  while (at + HEADER_BYTES <= input.length) {
    const frame = frameAt(input, at);
    const next = frame ? at + frame.bytes : at;
    const confirmed = frame !== null && (inStep || next === input.length || frameAt(input, next) !== null);
    if (!frame || !confirmed || next > input.length) {
      inStep = false;
      at += 1;
      continue;
    }
    seconds += frame.seconds;
    frames += 1;
    inStep = true;
    at = next;
  }
  return frames > 0 ? Math.round(seconds * 1000) : undefined;
}
