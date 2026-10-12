// @vitest-environment happy-dom
// A long voice note must survive a recognition error: the Mac keeps the
// recording, and Try again turns it into text in the box.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({
    ready: true,
    capabilities: {
      host: { platform: "darwin", label: "Mac", session: "unknown", packaged: true, homeDir: "/Users/me" },
      windowChrome: "native",
      screenPreview: { available: false, interaction: "none" },
      dictation: { available: true, engine: "apple", onDevice: true },
      localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable" },
    },
  }),
}));
const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: { ...original.initialState, instances: [{ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", capabilities: {} }] },
      dispatch: fixture.dispatch,
    }),
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { Composer } = await import("./Composer");
const { setLocale } = await import("@/lib/i18n");

let host: HTMLDivElement;
let root: Root;
const speech = {
  start: vi.fn(async (_options?: unknown) => {}),
  transcript: null as null | ((line: { text?: string; partial?: boolean }) => void),
  end: null as null | ((info: { code: number | null; reason?: string; recording?: string }) => void),
};
const bot: Bot = {
  id: "biscuit", threadId: "thread-voice", name: "Biscuit", title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [], busy: false,
  modelSelection: { instanceId: "claude", model: "claude-fake" },
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  setLocale("en");
  speech.start.mockClear();
  vi.stubGlobal("laterdog", {
    speechStart: speech.start,
    speechStop: vi.fn(async () => {}),
    onSpeechTranscript: (cb: typeof speech.transcript) => { speech.transcript = cb; return () => {}; },
    onSpeechEnd: (cb: typeof speech.end) => { speech.end = cb; return () => {}; },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("a voice note that recognition dropped", () => {
  it("is kept, and Try again transcribes the saved recording into the box", async () => {
    await act(async () => root.render(createElement(Composer, { bot })));
    await act(async () => host.querySelector<HTMLButtonElement>("button[aria-label='Start dictation']")!.click());
    expect(speech.start).toHaveBeenCalledWith(undefined);
    await act(async () => speech.transcript!({ partial: true, text: "draft the launch" }));
    await act(async () => speech.end!({ code: 1, reason: "recognition-error", recording: "/notes/a.caf" }));
    expect(host.querySelector("[data-voice-note]")!.textContent).toContain("Your voice note is saved.");
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("[data-voice-note] button")].find((button) => button.textContent === "Retry")!.click());
    expect(speech.start).toHaveBeenLastCalledWith({ file: "/notes/a.caf" });
    await act(async () => speech.transcript!({ partial: false, text: "draft the launch post for tomorrow" }));
    expect(host.querySelector("textarea")!.value).toBe("draft the launch post for tomorrow");
    await act(async () => speech.end!({ code: 0, reason: "completed" }));
    expect(host.querySelector("[data-voice-note]")).toBeNull();
  });
});
