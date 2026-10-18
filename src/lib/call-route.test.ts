import { describe, expect, it } from "vitest";

import { callRoute, callVoiceReady } from "./call-route";

const base = { capabilitiesReady: true, speechMissing: null, voiceReady: true, liveConfigured: false, name: "Ada" };

describe("which call the one voice button makes", () => {
  it("takes turns with the included voice whenever this window can listen, even with a Live key saved", () => {
    expect(callRoute(base)).toEqual({ kind: "turns" });
    expect(callRoute({ ...base, liveConfigured: true })).toEqual({ kind: "turns" });
  });

  it("makes a Live call only when taking turns can't work here and a Live key is already saved", () => {
    expect(callRoute({ ...base, speechMissing: "no speech", liveConfigured: true })).toEqual({ kind: "live" });
    expect(callRoute({ ...base, voiceReady: false, liveConfigured: true })).toEqual({ kind: "live" });
  });

  it("is unavailable with a plain reason, never a key request, when neither works", () => {
    expect(callRoute({ ...base, speechMissing: "Voice calls need the later.dog Mac app." }))
      .toEqual({ kind: "unavailable", reason: "Voice calls need the later.dog Mac app.", needsVoice: false });
    expect(callRoute({ ...base, voiceReady: false }))
      .toEqual({ kind: "unavailable", reason: "Ada doesn't have a voice to speak with yet.", needsVoice: true });
  });

  it("waits while this window's abilities are still being checked", () => {
    expect(callRoute({ ...base, capabilitiesReady: false, liveConfigured: true })).toEqual({ kind: "checking" });
  });

  it("counts the included voice, a picked voice, or the dog's own voice as ready", () => {
    expect(callVoiceReady({ configured: true, ready: true }, undefined)).toBe(true);
    expect(callVoiceReady({ configured: true, ready: false }, "voice-1")).toBe(true);
    expect(callVoiceReady({ configured: true, ready: false }, undefined)).toBe(false);
    expect(callVoiceReady({ configured: false, ready: true }, "voice-1")).toBe(false);
    expect(callVoiceReady(undefined, "voice-1")).toBe(false);
  });
});
