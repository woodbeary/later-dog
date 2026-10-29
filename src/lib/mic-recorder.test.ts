import { describe, expect, it } from "vitest";
import { DICTATION_SAMPLE_RATE, encodeWav, resample } from "./mic-recorder";

const text = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.slice(at, at + 4));

describe("mic recorder audio", () => {
  it("encodes mono 16-bit PCM WAV the transcription Worker accepts", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5, 2]), DICTATION_SAMPLE_RATE);
    const view = new DataView(wav.buffer);
    expect(text(wav, 0)).toBe("RIFF");
    expect(text(wav, 8)).toBe("WAVE");
    expect(text(wav, 12)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(wav, 36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(10);
    expect(wav.byteLength).toBe(54);
    expect(view.getInt16(46, true)).toBe(32_767);
    expect(view.getInt16(48, true)).toBe(-32_768);
    expect(view.getInt16(52, true)).toBe(32_767);
  });

  it("downsamples 48 kHz to 16 kHz by averaging each window", () => {
    const out = resample(new Float32Array([0.3, 0.3, 0.3, -0.6, 0, 0]), 48_000, 16_000);
    expect(Array.from(out).map((n) => Number(n.toFixed(4)))).toEqual([0.3, -0.2]);
    const same = new Float32Array([0.1]);
    expect(resample(same, 16_000, 16_000)).toBe(same);
  });
});
