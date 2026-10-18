import { describe, expect, it, vi } from "vitest";

import { evenLevels, levelsFromSamples, voiceNoteClock, voiceNoteLevels, VOICE_NOTE_BARS } from "./voice-note-levels";

describe("voice note bars", () => {
  it("measures one level per bar from the real samples, loudest bar full height", () => {
    const samples = new Float32Array(400);
    samples.fill(0.5, 0, 100);
    samples.fill(0.25, 100, 200);
    const levels = levelsFromSamples(samples, 4);
    expect(levels).toHaveLength(4);
    expect(levels[0]).toBe(1);
    expect(levels[1]).toBeCloseTo(0.5);
    expect(levels[2]).toBeGreaterThan(0);
    expect(levels[2]).toBe(levels[3]);
  });

  it("keeps silence as even low bars and never invents peaks", () => {
    expect(new Set(levelsFromSamples(new Float32Array(64), 8)).size).toBe(1);
    expect(new Set(evenLevels()).size).toBe(1);
    expect(evenLevels()).toHaveLength(VOICE_NOTE_BARS);
    expect(levelsFromSamples([], 8)).toEqual([]);
  });

  it("reads lengths as m:ss", () => {
    expect(voiceNoteClock(0)).toBe("0:00");
    expect(voiceNoteClock(4.2)).toBe("0:04");
    expect(voiceNoteClock(65.9)).toBe("1:05");
    expect(voiceNoteClock(Number.NaN)).toBe("0:00");
  });

  it("measures each note once, and gives up quietly when the audio can't be decoded", async () => {
    const load = vi.fn(async () => new ArrayBuffer(8));
    const decode = vi.fn(async () => ({ getChannelData: () => new Float32Array([0.5, 0.5, 0.1, 0.1]) }));
    const first = await voiceNoteLevels("/api/attachments/a.mp3", load, decode);
    const again = await voiceNoteLevels("/api/attachments/a.mp3", load, decode);
    expect(first).toHaveLength(VOICE_NOTE_BARS);
    expect(again).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    const broken = vi.fn(async () => { throw new Error("not audio"); });
    expect(await voiceNoteLevels("/api/attachments/b.mp3", load, broken)).toBeNull();
    expect(await voiceNoteLevels("/api/attachments/c.mp3", load, null)).toBeNull();
  });
});
