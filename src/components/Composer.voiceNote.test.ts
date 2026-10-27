// @vitest-environment happy-dom
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

const { Composer } = await import("./Composer");
const { setLocale } = await import("@/lib/i18n");

let host: HTMLDivElement;
let root: Root;
const speech = {
  start: vi.fn(async (_options?: unknown) => {}),
  stop: vi.fn(async (): Promise<{ recording?: string } | undefined> => undefined),
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
  speech.stop.mockReset();
  speech.stop.mockImplementation(async () => undefined);
  fixture.dispatch.mockClear();
  fixture.config = null;
  vi.stubGlobal("laterdog", {
    speechStart: speech.start,
    speechStop: speech.stop,
    onSpeechTranscript: (cb: typeof speech.transcript) => {
      speech.transcript = cb;
      return () => { if (speech.transcript === cb) speech.transcript = null; };
    },
    onSpeechEnd: (cb: typeof speech.end) => {
      speech.end = cb;
      return () => { if (speech.end === cb) speech.end = null; };
    },
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

describe("the mic and the send button", () => {
  let threads = 0;
  let talker: Bot;
  beforeEach(() => { talker = { ...bot, threadId: `thread-mic-${++threads}` }; });
  const mic = () => host.querySelector<HTMLButtonElement>("[data-composer-mic]");
  const sendButton = () => host.querySelector<HTMLButtonElement>("[data-composer-send]");
  const type = async (value: string) => {
    const box = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("sit side by side, with send waiting until there is something to send", async () => {
    await act(async () => root.render(createElement(Composer, { bot: talker })));
    expect(mic()!.getAttribute("aria-label")).toBe("Start dictation");
    expect(sendButton()!.disabled).toBe(true);
    await type("ship it");
    expect(mic()).not.toBeNull();
    expect(sendButton()!.disabled).toBe(false);
  });

  it("stay together while a voice note is being written into the box", async () => {
    await act(async () => root.render(createElement(Composer, { bot: talker })));
    await act(async () => mic()!.click());
    expect(mic()!.getAttribute("aria-pressed")).toBe("true");
    expect(sendButton()!.disabled).toBe(true);
    await act(async () => speech.transcript!({ partial: true, text: "draft the launch" }));
    expect(mic()!.getAttribute("aria-label")).toBe("Stop dictation");
    expect(sendButton()!.disabled).toBe(false);
  });

  it("sends what was heard so far and stops listening, so nothing refills the box", async () => {
    await act(async () => root.render(createElement(Composer, { bot: talker })));
    await act(async () => mic()!.click());
    await act(async () => speech.transcript!({ partial: true, text: "draft the launch" }));
    await act(async () => sendButton()!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "send", botId: "biscuit", text: "draft the launch" }));
    expect(speech.stop).toHaveBeenCalled();
    expect(speech.transcript).toBeNull();
    expect(host.querySelector("textarea")!.value).toBe("");
    expect(mic()!.getAttribute("aria-pressed")).toBe("false");
  });

  it("adds a voice note after what was already typed", async () => {
    await act(async () => root.render(createElement(Composer, { bot: talker })));
    await type("Hi team,");
    await act(async () => mic()!.click());
    await act(async () => speech.transcript!({ partial: false, text: "the launch moves to Friday" }));
    expect(host.querySelector("textarea")!.value).toBe("Hi team, the launch moves to Friday");
  });
});

describe("Escape during dictation", () => {
  let threads = 0;
  let talker: Bot;
  beforeEach(() => { talker = { ...bot, threadId: `thread-esc-${++threads}` }; });
  const mic = () => host.querySelector<HTMLButtonElement>("[data-composer-mic]")!;
  const box = () => host.querySelector("textarea")!;
  const escape = (target: EventTarget) => act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box(), value);
      box().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("says Esc cancels while listening", async () => {
    await act(async () => root.render(createElement(Composer, { bot: talker })));
    await act(async () => mic().click());
    expect(mic().title).toBe("Stop dictation · Esc cancels");
    expect(box().placeholder).toBe("Listening…");
  });

  it("cancels from the mic button: nothing heard is kept, the earlier text comes back exactly, and listening stops", async () => {
    await act(async () => root.render(createElement(Composer, { bot: talker })));
    await type("Hi team,  ");
    await act(async () => mic().click());
    await act(async () => speech.transcript!({ partial: true, text: "remind me to pack sunscreen" }));
    expect(box().value).toBe("Hi team, remind me to pack sunscreen");
    mic().focus();
    await escape(mic());
    expect(box().value).toBe("Hi team,  ");
    expect(speech.stop).toHaveBeenCalled();
    expect(speech.transcript).toBeNull();
    expect(mic().getAttribute("aria-pressed")).toBe("false");
    expect(mic().getAttribute("aria-label")).toBe("Start dictation");
    expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send" }));
  });

  it("cancels from the text box too, and never sends audio off to be transcribed", async () => {
    const speechAudio = vi.fn(async () => new Uint8Array([1]));
    vi.stubGlobal("laterdog", { ...(globalThis as unknown as { laterdog: object }).laterdog, speechAudio });
    speech.stop.mockImplementation(async () => ({ recording: "/notes/esc.caf" }));
    await act(async () => root.render(createElement(Composer, { bot: talker })));
    await act(async () => mic().click());
    await act(async () => speech.transcript!({ partial: true, text: "what is a good snack" }));
    await escape(box());
    await act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(box().value).toBe("");
    expect(speechAudio).not.toHaveBeenCalled();
    expect(host.querySelector("[data-dictation-status]")).toBeNull();
  });

  it("leaves Escape alone when nobody is dictating", async () => {
    await act(async () => root.render(createElement(Composer, { bot: talker })));
    await type("keep me");
    await escape(box());
    expect(box().value).toBe("keep me");
    expect(speech.stop).not.toHaveBeenCalled();
  });
});

describe("sharper dictation", () => {
  const WAV = new Uint8Array([82, 73, 70, 70, 1, 2]);
  const HEARD = "Draft the launch post for Friday.";
  let threads = 0;
  let talker: Bot;
  let speechAudio: ReturnType<typeof vi.fn<(file: string) => Promise<Uint8Array | null>>>;
  let transcribe: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
  let release: (response: Response) => void;
  const mic = () => host.querySelector<HTMLButtonElement>("[data-composer-mic]")!;
  const box = () => host.querySelector("textarea")!;
  const settle = () => act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const answerLater = () => {
    transcribe.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
  };
  const dictate = async (said: string) => {
    await act(async () => root.render(createElement(Composer, { bot: talker })));
    await act(async () => mic().click());
    await act(async () => speech.transcript!({ partial: true, text: said }));
  };
  const stopWithRecording = async (recording = "/notes/b.caf") => {
    speech.stop.mockImplementationOnce(async () => ({ recording }));
    await act(async () => mic().click());
    await settle();
  };

  beforeEach(() => {
    talker = { ...bot, threadId: `thread-sharp-${++threads}` };
    speechAudio = vi.fn(async (_file: string): Promise<Uint8Array | null> => WAV);
    transcribe = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ text: HEARD, language: "en", included: true }));
    vi.stubGlobal("laterdog", { ...(globalThis as unknown as { laterdog: object }).laterdog, speechAudio });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      String(url).startsWith("/api/voice/transcribe") ? transcribe(String(url), init) : new Response("{}", { status: 200 })));
  });

  it("swaps the on-device draft for the sharper text once you stop talking", async () => {
    await dictate("draft the lunch post for friday");
    await stopWithRecording();
    expect(speechAudio).toHaveBeenCalledWith("/notes/b.caf");
    expect(transcribe).toHaveBeenCalledWith("/api/voice/transcribe?language=en", expect.objectContaining({ method: "POST", body: WAV }));
    expect(box().value).toBe(HEARD);
    expect(mic().getAttribute("aria-busy")).toBeNull();
  });

  it("keeps what was typed before the voice note", async () => {
    await act(async () => root.render(createElement(Composer, { bot: talker })));
    const textarea = box();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Hi team,");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => mic().click());
    await act(async () => speech.transcript!({ partial: true, text: "draft the lunch post" }));
    await stopWithRecording();
    expect(box().value).toBe(`Hi team, ${HEARD}`);
  });

  it("shows a spinner on the mic while it transcribes, and leaves your own edits alone", async () => {
    answerLater();
    await dictate("draft the lunch post");
    await stopWithRecording();
    expect(mic().getAttribute("aria-busy")).toBe("true");
    expect(mic().title).toBe("Transcribing…");
    expect(host.querySelector("[data-dictation-status]")!.textContent).toBe("Transcribing…");
    expect(host.querySelector("[data-dictation-status]")!.getAttribute("role")).toBe("status");
    const textarea = box();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "never mind, I'll write it");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    release(Response.json({ text: HEARD }));
    await settle();
    expect(box().value).toBe("never mind, I'll write it");
    expect(mic().getAttribute("aria-busy")).toBeNull();
    expect(host.querySelector("[data-dictation-status]")).toBeNull();
  });

  it("doesn't refill the box after the message was already sent", async () => {
    answerLater();
    await dictate("draft the lunch post");
    await stopWithRecording();
    await act(async () => host.querySelector<HTMLButtonElement>("[data-composer-send]")!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "send", text: "draft the lunch post" }));
    release(Response.json({ text: HEARD }));
    await settle();
    expect(box().value).toBe("");
  });

  it("keeps the on-device text and says a key would make it cloud dictation when no service can help", async () => {
    transcribe.mockImplementation(async () => Response.json({ error: "No transcription service is set up.", reason: "no-service" }, { status: 409 }));
    await dictate("draft the lunch post");
    await stopWithRecording();
    expect(box().value).toBe("draft the lunch post");
    expect(host.querySelector("[data-voice-note]")!.textContent).toContain("Transcribed on this Mac. Add an xAI or ElevenLabs key");
  });

  it("fills the box instead of an error when on-device recognition drops the note", async () => {
    await dictate("draft the");
    await act(async () => speech.end!({ code: 1, reason: "recognition-error", recording: "/notes/c.caf" }));
    await settle();
    expect(speechAudio).toHaveBeenCalledWith("/notes/c.caf");
    expect(box().value).toBe(HEARD);
    expect(host.querySelector("[data-voice-note]")).toBeNull();
  });

  it("still offers Retry for a dropped note when the service fails too", async () => {
    transcribe.mockImplementation(async () => Response.json({ error: "down" }, { status: 502 }));
    await dictate("draft the");
    await act(async () => speech.end!({ code: 1, reason: "recognition-error", recording: "/notes/c.caf" }));
    await settle();
    expect(host.querySelector("[data-voice-note]")!.textContent).toContain("Your voice note is saved.");
    expect([...host.querySelectorAll("[data-voice-note] button")].some((button) => button.textContent === "Retry")).toBe(true);
  });

  it("keeps voice notes on this Mac when cloudDictation is false in the config", async () => {
    fixture.config = { features: { cloudDictation: false } };
    await dictate("draft the lunch post");
    await stopWithRecording();
    expect(box().value).toBe("draft the lunch post");
    await act(async () => mic().click());
    await act(async () => speech.end!({ code: 1, reason: "recognition-error", recording: "/notes/d.caf" }));
    await settle();
    expect(host.querySelector("[data-voice-note]")!.textContent).toContain("Your voice note is saved.");
    expect(speechAudio).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe("the dictation strip", () => {
  let threads = 0;
  let talker: Bot;
  beforeEach(() => { talker = { ...bot, threadId: `thread-strip-${++threads}` }; });
  afterEach(() => { vi.useRealTimers(); });
  const mic = () => host.querySelector<HTMLButtonElement>("[data-composer-mic]")!;
  const box = () => host.querySelector("textarea")!;
  const strip = () => host.querySelector<HTMLElement>("[data-dictation-strip]");
  const composer = () => host.querySelector<HTMLElement>("[data-tour='composer']")!;
  const heights = () => [...host.querySelectorAll<HTMLElement>("[data-dictation-level]")].map((bar) => parseFloat(bar.style.height));
  const clock = () => host.querySelector("[data-dictation-clock]")!.textContent;
  const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box(), value);
      box().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("is hidden until you start dictating, then sits inside the box with cancel, level bars and a clock", async () => {
    await act(async () => root.render(createElement(Composer, { bot: talker })));
    expect(strip()).toBeNull();
    await act(async () => mic().click());
    expect(composer().contains(strip())).toBe(true);
    expect(strip()!.getAttribute("role")).toBe("group");
    expect(strip()!.getAttribute("aria-label")).toBe("Dictation in progress");
    expect(strip()!.querySelector("button[aria-label='Cancel dictation']")).not.toBeNull();
    expect(heights()).toHaveLength(28);
    expect(strip()!.querySelector("[data-dictation-levels]")!.getAttribute("aria-hidden")).toBe("true");
    expect(clock()).toBe("0:00");
  });

  it("turns the mic into a quiet check that keeps what was heard, with no red pulse", async () => {
    await act(async () => root.render(createElement(Composer, { bot: talker })));
    await act(async () => mic().click());
    expect(mic().className).not.toContain("animate-pulse");
    expect(mic().className).not.toContain("danger");
    expect(mic().querySelector("svg.lucide-check")).not.toBeNull();
    await act(async () => speech.transcript!({ partial: true, text: "ship the beta" }));
    await act(async () => mic().click());
    expect(strip()).toBeNull();
    expect(box().value).toBe("ship the beta");
    expect(mic().querySelector("svg.lucide-mic")).not.toBeNull();
  });

  it("counts the time and lifts the bars while words come in", async () => {
    vi.useFakeTimers();
    await act(async () => root.render(createElement(Composer, { bot: talker })));
    await act(async () => mic().click());
    await wait(400);
    expect(Math.max(...heights())).toBeLessThanOrEqual(3);
    await act(async () => speech.transcript!({ partial: true, text: "remind me to call the vet tomorrow" }));
    await wait(160);
    expect(Math.max(...heights())).toBeGreaterThan(8);
    await wait(1_000);
    expect(clock()).toBe("0:01");
    await wait(2_000);
    expect(Math.max(...heights().slice(-4))).toBeLessThanOrEqual(3);
  });

  it("keeps the bars still when reduced motion is on, while the clock still counts", async () => {
    vi.useFakeTimers();
    document.documentElement.dataset.reducedMotion = "true";
    try {
      await act(async () => root.render(createElement(Composer, { bot: talker })));
      await act(async () => mic().click());
      await act(async () => speech.transcript!({ partial: true, text: "remind me to call the vet tomorrow" }));
      await wait(1_200);
      expect(heights().every((height) => height === 3)).toBe(true);
      expect(clock()).toBe("0:01");
    } finally {
      delete document.documentElement.dataset.reducedMotion;
    }
  });

  it("cancels like Esc: the words heard are dropped and the earlier text comes back", async () => {
    await act(async () => root.render(createElement(Composer, { bot: talker })));
    await type("Hi team,");
    await act(async () => mic().click());
    await act(async () => speech.transcript!({ partial: true, text: "never mind" }));
    expect(box().value).toBe("Hi team, never mind");
    await act(async () => strip()!.querySelector<HTMLButtonElement>("[data-dictation-cancel]")!.click());
    expect(box().value).toBe("Hi team,");
    expect(strip()).toBeNull();
    expect(speech.stop).toHaveBeenCalled();
    expect(speech.transcript).toBeNull();
    expect(mic().getAttribute("aria-pressed")).toBe("false");
  });

  it("shows Transcribing… in the same place inside the box while the cloud is working", async () => {
    let release: (response: Response) => void = () => {};
    vi.stubGlobal("laterdog", { ...(globalThis as unknown as { laterdog: object }).laterdog, speechAudio: vi.fn(async () => new Uint8Array([1])) });
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) =>
      String(url).startsWith("/api/voice/transcribe")
        ? new Promise<Response>((resolve) => { release = resolve; })
        : Promise.resolve(new Response("{}", { status: 200 }))));
    const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => root.render(createElement(Composer, { bot: talker })));
    await act(async () => mic().click());
    await act(async () => speech.transcript!({ partial: true, text: "draft the lunch post" }));
    speech.stop.mockImplementationOnce(async () => ({ recording: "/notes/strip.caf" }));
    await act(async () => mic().click());
    await settle();
    const status = host.querySelector<HTMLElement>("[data-dictation-status]")!;
    expect(composer().contains(status)).toBe(true);
    expect(status.textContent).toBe("Transcribing…");
    expect(strip()).toBeNull();
    release(Response.json({ text: "Draft the launch post." }));
    await settle();
    expect(host.querySelector("[data-dictation-status]")).toBeNull();
    expect(box().value).toBe("Draft the launch post.");
  });
});
