// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), config: null as null | { features?: { cloudDictation?: boolean } } }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: {
        ...original.initialState,
        config: fixture.config as unknown as typeof original.initialState.config,
        instances: [{ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", capabilities: {} }],
      },
      dispatch: fixture.dispatch,
    }),
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
const mic = vi.hoisted(() => ({
  supported: true,
  failWith: null as null | "denied" | "unsupported" | "failed",
  audio: new Uint8Array([82, 73, 70, 70, 1, 2]) as Uint8Array<ArrayBuffer> | null,
  silent: false,
  level: null as null | ((level: number) => void),
  starts: 0,
  stops: 0,
  cancels: 0,
}));
vi.mock("@/lib/mic-recorder", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/mic-recorder")>();
  return {
    ...original,
    micRecordingSupported: () => mic.supported,
    startMicRecorder: async (onLevel?: (level: number) => void) => {
      mic.starts += 1;
      if (mic.failWith) throw new original.MicUnavailableError(mic.failWith);
      mic.level = onLevel ?? null;
      return {
        stop: async () => {
          mic.stops += 1;
          if (mic.silent) throw new original.MicUnavailableError("denied");
          return mic.audio;
        },
        cancel: () => { mic.cancels += 1; },
      };
    },
  };
});

const { Composer } = await import("./Composer");
const { setLocale } = await import("@/lib/i18n");

const HEARD = "Draft the launch post for Friday.";
let host: HTMLDivElement;
let root: Root;
let threads = 0;
let talker: Bot;
let transcribe: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
let release: (response: Response) => void = () => {};
const bot: Bot = {
  id: "biscuit", threadId: "thread-voice", name: "Biscuit", title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [], busy: false,
  modelSelection: { instanceId: "claude", model: "claude-fake" },
};

const micButton = () => host.querySelector<HTMLButtonElement>("[data-composer-mic]");
const sendButton = () => host.querySelector<HTMLButtonElement>("[data-composer-send]");
const box = () => host.querySelector("textarea")!;
const strip = () => host.querySelector<HTMLElement>("[data-dictation-strip]");
const voiceNote = () => host.querySelector<HTMLElement>("[data-voice-note]");
const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
});
const render = () => act(async () => root.render(createElement(Composer, { bot: talker })));
const click = async (button: HTMLButtonElement | null) => {
  await act(async () => button!.click());
  await settle();
};
const type = async (value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box(), value);
    box().dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const escape = (target: EventTarget) => act(async () => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
});
const answerLater = () => {
  transcribe.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  Object.assign(mic, { supported: true, failWith: null, audio: new Uint8Array([82, 73, 70, 70, 1, 2]), silent: false, level: null, starts: 0, stops: 0, cancels: 0 });
  fixture.dispatch.mockClear();
  fixture.config = null;
  talker = { ...bot, threadId: `thread-voice-${++threads}` };
  transcribe = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ text: HEARD, language: "en", included: true }));
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    String(url).startsWith("/api/voice/transcribe") ? transcribe(String(url), init) : new Response("{}", { status: 200 })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("cloud dictation", () => {
  it("records in the page and sends the audio to cloud transcription when you stop", async () => {
    await render();
    await click(micButton());
    expect(mic.starts).toBe(1);
    expect(micButton()!.getAttribute("aria-pressed")).toBe("true");
    await click(micButton());
    expect(mic.stops).toBe(1);
    expect(transcribe).toHaveBeenCalledWith("/api/voice/transcribe?language=en", expect.objectContaining({ method: "POST", body: mic.audio }));
    expect(box().value).toBe(HEARD);
    expect(micButton()!.getAttribute("aria-busy")).toBeNull();
  });

  it("works without the desktop app's speech bridge", async () => {
    expect((globalThis as { laterdog?: unknown }).laterdog).toBeUndefined();
    await render();
    expect(micButton()).not.toBeNull();
  });

  it("hides the mic where the page can't record", async () => {
    mic.supported = false;
    await render();
    expect(micButton()).toBeNull();
  });

  it("adds the voice note after what was already typed", async () => {
    await render();
    await type("Hi team,");
    await click(micButton());
    await click(micButton());
    expect(box().value).toBe(`Hi team, ${HEARD}`);
  });

  it("shows a spinner while it transcribes, and leaves your own edits alone", async () => {
    answerLater();
    await render();
    await click(micButton());
    await click(micButton());
    expect(micButton()!.getAttribute("aria-busy")).toBe("true");
    expect(micButton()!.title).toBe("Transcribing…");
    expect(host.querySelector("[data-dictation-status]")!.textContent).toBe("Transcribing…");
    await type("never mind, I'll write it");
    release(Response.json({ text: HEARD }));
    await settle();
    expect(box().value).toBe("never mind, I'll write it");
    expect(micButton()!.getAttribute("aria-busy")).toBeNull();
    expect(host.querySelector("[data-dictation-status]")).toBeNull();
  });

  it("doesn't refill the box after the message was already sent", async () => {
    answerLater();
    await render();
    await type("ship it");
    await click(micButton());
    await click(micButton());
    await click(sendButton());
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "send", text: "ship it" }));
    release(Response.json({ text: HEARD }));
    await settle();
    expect(box().value).toBe("");
  });

  it("drops the recording when you send while still listening", async () => {
    await render();
    await type("ship it");
    await click(micButton());
    await click(sendButton());
    expect(mic.cancels).toBe(1);
    expect(transcribe).not.toHaveBeenCalled();
    expect(micButton()!.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("when transcription can't help", () => {
  it("says how to set up a service, keeps the note and offers Retry", async () => {
    transcribe.mockImplementation(async () => Response.json({ error: "No transcription service is set up.", reason: "no-service" }, { status: 409 }));
    await render();
    await click(micButton());
    await click(micButton());
    expect(voiceNote()!.textContent).toContain("Start the free trial, or add an ElevenLabs or xAI key");
    expect(voiceNote()!.textContent).toContain("Your voice note is saved.");
  });

  it("says when dictation is turned off", async () => {
    transcribe.mockImplementation(async () => Response.json({ error: "Sharper dictation is turned off.", reason: "off" }, { status: 409 }));
    await render();
    await click(micButton());
    await click(micButton());
    expect(voiceNote()!.textContent).toContain("Dictation is turned off in Settings.");
  });

  it("transcribes the same saved audio again on Retry", async () => {
    transcribe.mockImplementationOnce(async () => Response.json({ error: "down" }, { status: 502 }));
    await render();
    await click(micButton());
    await click(micButton());
    expect(voiceNote()!.textContent).toContain("Transcription didn't come back. Your voice note is saved.");
    await click([...host.querySelectorAll<HTMLButtonElement>("[data-voice-note] button")].find((button) => button.textContent === "Retry")!);
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(transcribe.mock.calls[1]![1]!.body).toBe(mic.audio);
    expect(mic.starts).toBe(1);
    expect(box().value).toBe(HEARD);
    expect(voiceNote()).toBeNull();
  });

  it("asks for microphone access when it's refused", async () => {
    mic.failWith = "denied";
    await render();
    await click(micButton());
    expect(voiceNote()!.textContent).toContain("Dictation needs microphone access");
    expect(micButton()!.getAttribute("aria-pressed")).toBe("false");
    expect(strip()).toBeNull();
  });

  it("asks for microphone access when the recording comes back silent", async () => {
    mic.silent = true;
    await render();
    await click(micButton());
    await click(micButton());
    expect(transcribe).not.toHaveBeenCalled();
    expect(voiceNote()!.textContent).toContain("Dictation needs microphone access");
  });
});

describe("cancelling", () => {
  it("says Esc cancels while listening", async () => {
    await render();
    await click(micButton());
    expect(micButton()!.title).toBe("Stop dictation · Esc cancels");
    expect(box().placeholder).toBe("Listening…");
  });

  it("Esc brings back the earlier text exactly and never sends the audio", async () => {
    await render();
    await type("Hi team,  ");
    await click(micButton());
    await escape(box());
    await settle();
    expect(box().value).toBe("Hi team,  ");
    expect(mic.cancels).toBe(1);
    expect(transcribe).not.toHaveBeenCalled();
    expect(micButton()!.getAttribute("aria-label")).toBe("Start dictation");
    expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send" }));
  });

  it("the strip's cancel button works like Esc", async () => {
    await render();
    await type("Hi team,");
    await click(micButton());
    await click(strip()!.querySelector<HTMLButtonElement>("[data-dictation-cancel]"));
    expect(box().value).toBe("Hi team,");
    expect(strip()).toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("leaves Escape alone when nobody is dictating", async () => {
    await render();
    await type("keep me");
    await escape(box());
    expect(box().value).toBe("keep me");
    expect(mic.cancels).toBe(0);
  });
});

describe("the dictation strip", () => {
  const heights = () => [...host.querySelectorAll<HTMLElement>("[data-dictation-level]")].map((bar) => parseFloat(bar.style.height));
  const clock = () => host.querySelector("[data-dictation-clock]")!.textContent;
  const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it("sits inside the box with cancel, level bars and a clock", async () => {
    await render();
    expect(strip()).toBeNull();
    await click(micButton());
    expect(host.querySelector<HTMLElement>("[data-tour='composer']")!.contains(strip())).toBe(true);
    expect(strip()!.getAttribute("aria-label")).toBe("Dictation in progress");
    expect(heights()).toHaveLength(28);
    expect(clock()).toBe("0:00");
    expect(micButton()!.querySelector("svg.lucide-check")).not.toBeNull();
  });

  it("moves the bars with your voice and counts the time", async () => {
    vi.useFakeTimers();
    await render();
    await act(async () => micButton()!.click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await wait(400);
    expect(Math.max(...heights())).toBeLessThanOrEqual(3);
    act(() => mic.level!(0.9));
    await wait(160);
    expect(Math.max(...heights())).toBeGreaterThan(8);
    await wait(1_000);
    expect(clock()).toBe("0:01");
  });

  it("keeps the bars still when reduced motion is on, while the clock still counts", async () => {
    vi.useFakeTimers();
    document.documentElement.dataset.reducedMotion = "true";
    try {
      await render();
      await act(async () => micButton()!.click());
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      act(() => mic.level!(0.9));
      await wait(1_200);
      expect(heights().every((height) => height === 3)).toBe(true);
      expect(clock()).toBe("0:01");
    } finally {
      delete document.documentElement.dataset.reducedMotion;
    }
  });
});
