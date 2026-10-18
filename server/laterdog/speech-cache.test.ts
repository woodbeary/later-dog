import { describe, expect, it, vi } from "vitest";

import { configuredSpeechKey, SpeechCache, speechCacheKey } from "./speech-cache.ts";

const clip = (size: number, mark = 1) => ({ bytes: new Uint8Array(size).fill(mark), mime: "audio/mpeg" });

describe("the speech cache behind /api/tts/speak", () => {
  it("synthesizes the same words in the same voice once", async () => {
    const cache = new SpeechCache();
    const synthesize = vi.fn(async () => clip(10));
    const key = configuredSpeechKey("elevenlabs", { voice: "v-1" }, "Plan on about 1.5 liters.");
    const first = await cache.speak(key, synthesize);
    const second = await cache.speak(key, synthesize);
    expect(second).toBe(first);
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("never reuses audio across voices, providers, models or words", () => {
    const keys = new Set([
      configuredSpeechKey("elevenlabs", { voice: "v-1" }, "Hi"),
      configuredSpeechKey("elevenlabs", { voice: "v-2" }, "Hi"),
      configuredSpeechKey("elevenlabs", { voice: "v-1" }, "Hi", "v-3"),
      configuredSpeechKey("fish", { voice: "v-1" }, "Hi"),
      configuredSpeechKey("chatterbox", { voice: "v-1", model: "turbo" }, "Hi"),
      configuredSpeechKey("chatterbox", { voice: "v-1", baseUrl: "http://other" }, "Hi"),
      configuredSpeechKey("elevenlabs", { voice: "v-1" }, "Hi."),
    ]);
    expect(keys.size).toBe(7);
    expect(speechCacheKey({ provider: "a", voice: "b|c", model: "", text: "" }))
      .not.toBe(speechCacheKey({ provider: "a", voice: "b", model: "c", text: "" }));
  });

  it("shares one synthesis between requests that arrive together", async () => {
    const cache = new SpeechCache();
    let finish!: (value: ReturnType<typeof clip>) => void;
    const synthesize = vi.fn(() => new Promise<ReturnType<typeof clip>>((resolve) => { finish = resolve; }));
    const both = Promise.all([cache.speak("k", synthesize), cache.speak("k", synthesize)]);
    finish(clip(4));
    const [a, b] = await both;
    expect(a).toBe(b);
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("keeps no failure, so the next request tries again", async () => {
    const cache = new SpeechCache();
    const synthesize = vi.fn()
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce(clip(4));
    await expect(cache.speak("k", synthesize)).rejects.toThrow("provider down");
    await expect(cache.speak("k", synthesize)).resolves.toMatchObject({ mime: "audio/mpeg" });
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(cache.entries).toBe(1);
  });

  it("stays inside its entry and byte limits, dropping the least recently heard clip", async () => {
    const cache = new SpeechCache({ maxEntries: 2, maxBytes: 100 });
    await cache.speak("a", async () => clip(40));
    await cache.speak("b", async () => clip(40));
    await cache.speak("a", async () => clip(40, 9));
    await cache.speak("c", async () => clip(40));
    expect(cache.entries).toBe(2);
    expect(cache.bytes).toBe(80);
    const again = vi.fn(async () => clip(40));
    await cache.speak("a", again);
    expect(again).not.toHaveBeenCalled();
    await cache.speak("b", again);
    expect(again).toHaveBeenCalledTimes(1);
    await cache.speak("big", async () => clip(70));
    expect(cache.bytes).toBeLessThanOrEqual(100);
    await cache.speak("huge", async () => clip(500));
    expect(cache.bytes).toBeLessThanOrEqual(100);
    const empty = vi.fn(async () => clip(0));
    await cache.speak("empty", empty);
    await cache.speak("empty", empty);
    expect(empty).toHaveBeenCalledTimes(2);
  });
});
