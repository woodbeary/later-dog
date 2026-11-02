import { describe, expect, it, vi } from "vitest";
import { STREAM_RATE, createVoiceStreams, decodeAdpcm, freshAdpcm, joinPieces, nextCut, wavFrom, type AdpcmState } from "./voice-stream.ts";

const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411,
  1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const SHIFT = [-1, -1, -1, -1, 2, 4, 6, 8];

function encode(pcm: Int16Array, state: AdpcmState): Uint8Array {
  const out = new Uint8Array(pcm.length / 2);
  for (let at = 0; at < pcm.length; at++) {
    const step = STEPS[state.index]!;
    let diff = pcm[at]! - state.predictor;
    let nibble = 0;
    if (diff < 0) { nibble = 8; diff = -diff; }
    let delta = step >> 3;
    if (diff >= step) { nibble |= 4; diff -= step; delta += step; }
    if (diff >= step >> 1) { nibble |= 2; diff -= step >> 1; delta += step >> 1; }
    if (diff >= step >> 2) { nibble |= 1; delta += step >> 2; }
    state.predictor = Math.max(-32768, Math.min(32767, state.predictor + (nibble & 8 ? -delta : delta)));
    state.index = Math.max(0, Math.min(88, state.index + SHIFT[nibble & 7]!));
    out[at >> 1]! |= at & 1 ? nibble << 4 : nibble;
  }
  return out;
}

function speech(seconds: number, pauses: number[] = []): Int16Array {
  const pcm = new Int16Array(Math.round(seconds * STREAM_RATE));
  for (let at = 0; at < pcm.length; at++) {
    const t = at / STREAM_RATE;
    const quiet = pauses.some((start) => t >= start && t < start + 0.4);
    pcm[at] = quiet ? 0 : Math.round(6000 * Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)));
  }
  return pcm;
}

describe("streamed dictation on the home", () => {
  it("decodes the phone's 4-bit audio back to a close copy of what it recorded", () => {
    const pcm = speech(1);
    const back = decodeAdpcm(encode(pcm, freshAdpcm()), freshAdpcm());
    let error = 0;
    for (let at = 0; at < pcm.length; at++) error += Math.abs(back[at]! - pcm[at]!);
    expect(back.length).toBe(pcm.length);
    expect(error / pcm.length).toBeLessThan(150);
  });

  it("writes a 16-bit mono WAV the transcription service takes", () => {
    const wav = wavFrom(new Int16Array([1, -1, 300]));
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(STREAM_RATE);
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(6);
    expect(wav.byteLength).toBe(50);
  });

  it("cuts the recording at a pause once a few seconds have built up, and not before", () => {
    const pcm = speech(10, [1.5, 5]);
    expect(nextCut(pcm, 0, 3 * STREAM_RATE)).toBeNull();
    const cut = nextCut(pcm, 0, pcm.length)!;
    expect(cut / STREAM_RATE).toBeGreaterThan(5);
    expect(cut / STREAM_RATE).toBeLessThan(5.4);
  });

  it("cuts a long stretch with no pause at its quietest point", () => {
    expect(nextCut(speech(10), 0, 10 * STREAM_RATE)).toBeNull();
    const cut = nextCut(speech(16), 0, 16 * STREAM_RATE)!;
    expect(cut).toBeGreaterThanOrEqual(2 * STREAM_RATE);
    expect(cut).toBeLessThanOrEqual(15 * STREAM_RATE);
  });

  it("transcribes the finished parts while you are still talking, so only the last part is left at the end", async () => {
    const heard: number[] = [];
    const transcribe = vi.fn(async (wav: Uint8Array) => {
      heard.push((wav.byteLength - 44) / 2 / STREAM_RATE);
      return `part ${heard.length}`;
    });
    const streams = createVoiceStreams();
    const pcm = speech(14, [4.5, 9.5]);
    const phone = freshAdpcm();
    const second = STREAM_RATE;
    for (let seq = 0; seq < 14; seq++) {
      const chunk = encode(pcm.subarray(seq * second, (seq + 1) * second), phone);
      const answer = await streams.add("dictation-1", seq, chunk, seq === 13, transcribe);
      if (seq === 6) expect(transcribe).toHaveBeenCalledTimes(1);
      if (seq === 13) expect(answer).toMatchObject({ ok: true, done: true, text: "part 1 part 2 part 3", timings: { pieces: 3 } });
      else expect(answer).toEqual({ ok: true, done: false });
    }
    expect(heard.reduce((a, b) => a + b, 0)).toBeCloseTo(14, 1);
    expect(heard.at(-1)).toBeLessThan(5);
    expect(streams.size()).toBe(0);
  });

  it("puts back the full stop the service leaves off the end of each piece", () => {
    expect(joinPieces(["Can you look at the app today?", "I want to know why", "It should feel instant", " thanks "])).toBe("Can you look at the app today? I want to know why. It should feel instant thanks");
    expect(joinPieces(["", "hi"])).toBe("hi");
  });

  it("refuses parts out of order and answers a repeated part without adding it twice", async () => {
    const streams = createVoiceStreams();
    const transcribe = vi.fn(async () => "hi");
    const chunk = new Uint8Array(800);
    expect(await streams.add("dictation-2", 1, chunk, false, transcribe)).toMatchObject({ ok: false, status: 409 });
    expect(await streams.add("dictation-2", 0, chunk, false, transcribe)).toEqual({ ok: true, done: false });
    expect(await streams.add("dictation-2", 0, chunk, false, transcribe)).toEqual({ ok: true, done: false });
    expect(await streams.add("dictation-2", 2, chunk, false, transcribe)).toMatchObject({ ok: false, status: 409 });
    const done = await streams.add("dictation-2", 1, chunk, true, transcribe);
    expect(done).toMatchObject({ ok: true, done: true, text: "hi", timings: { pieces: 1 } });
  });

  it("passes on a failed part so the phone can send the whole recording instead", async () => {
    const streams = createVoiceStreams();
    const answer = await streams.add("dictation-3", 0, new Uint8Array(8000), true, async () => { throw new Error("The included transcription did not answer (503)."); });
    expect(answer).toEqual({ ok: false, status: 502, error: "The included transcription did not answer (503)." });
  });

  it("forgets a dictation nobody finished", async () => {
    let clock = 0;
    const streams = createVoiceStreams(() => clock);
    await streams.add("dictation-4", 0, new Uint8Array(800), false, async () => "x");
    clock = 121_000;
    await streams.add("dictation-5", 0, new Uint8Array(800), false, async () => "x");
    expect(streams.size()).toBe(1);
  });
});
