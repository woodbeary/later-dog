import { describe, expect, it } from "vitest";

import { callSpeechMissing } from "./call-capability";

function capabilities(
  dictation: DesktopCapabilities["dictation"],
  platform: DesktopCapabilities["host"]["platform"] = "darwin",
): DesktopCapabilities {
  return {
    host: { platform, label: "macOS", session: "unknown", packaged: true },
    windowChrome: "mac-inset",
    screenPreview: { available: true, interaction: "direct" },
    dictation,
    localComputer: { available: true, support: "supported", enabled: true, status: "ready" },
  };
}
const none = { available: false, engine: "none", onDevice: false } as const;

describe("why a voice call can't listen here", () => {
  it("says nothing when the Mac's speech recognition and its service are there", () => {
    expect(callSpeechMissing(capabilities({ available: true, engine: "apple-speech", onDevice: true }), true)).toBeNull();
  });

  it("names the missing speech service in plain words", () => {
    expect(callSpeechMissing(capabilities({ available: true, engine: "apple-speech", onDevice: true }), false))
      .toBe("Speech recognition is missing from this app build. Restart or update later.dog.");
  });

  it("never says This computer", () => {
    for (const reasonCode of ["remote-server", "desktop-app-required", "unsupported-platform", "dictation-disabled"] as const) {
      for (const platform of ["darwin", "win32", "linux"] as const) {
        const reason = callSpeechMissing(capabilities({ ...none, reasonCode }, platform), false);
        expect(reason).toBeTruthy();
        expect(reason).not.toMatch(/This computer/i);
      }
    }
  });

  it("points at the Mac app off the Mac, and at the person's own window on another server's page", () => {
    expect(callSpeechMissing(capabilities({ ...none, reasonCode: "unsupported-platform" }, "win32"), false)).toBe("Voice calls need the later.dog Mac app.");
    expect(callSpeechMissing(capabilities({ ...none, reasonCode: "desktop-app-required" }), false)).toBe("Voice calls need the later.dog Mac app.");
    expect(callSpeechMissing(capabilities({ ...none, reasonCode: "remote-server" }), false)).toBe("Voice calls work in your own later.dog window, not on this page.");
  });
});
