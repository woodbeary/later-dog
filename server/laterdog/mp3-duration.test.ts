import { describe, expect, it } from "vitest";

import { mp3DurationMs } from "./mp3-duration.ts";

function frames(count: number, header: [number, number, number, number], length: number): Uint8Array {
  const out = new Uint8Array(count * length);
  for (let i = 0; i < count; i += 1) out.set(header, i * length);
  return out;
}

function id3(size: number): Uint8Array {
  const tag = new Uint8Array(10 + size);
  tag.set([0x49, 0x44, 0x33, 4, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  return tag;
}

const MPEG1_128K_44K: [number, number, number, number] = [0xff, 0xfb, 0x90, 0x00];
const MPEG2_64K_24K: [number, number, number, number] = [0xff, 0xf3, 0x84, 0x00];

describe("voice note length from the MP3 itself", () => {
  it("adds up MPEG-1 Layer III frames", () => {
    expect(mp3DurationMs(frames(40, MPEG1_128K_44K, 417))).toBe(1045);
  });

  it("skips an ID3 tag at the start", () => {
    const body = frames(100, MPEG1_128K_44K, 417);
    const tagged = new Uint8Array([...id3(300), ...body]);
    expect(mp3DurationMs(tagged)).toBe(2612);
  });

  it("reads MPEG-2 frames at their own sample rate", () => {
    expect(mp3DurationMs(frames(50, MPEG2_64K_24K, 192))).toBe(1200);
  });

  it("has no length for bytes that are not MP3 audio", () => {
    expect(mp3DurationMs(new TextEncoder().encode("ID3 fake mp3 for the voice note fixture"))).toBeUndefined();
    expect(mp3DurationMs(new Uint8Array())).toBeUndefined();
    expect(mp3DurationMs(new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]))).toBeUndefined();
  });
});
