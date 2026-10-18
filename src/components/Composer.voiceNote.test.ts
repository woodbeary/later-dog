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
    const textarea = box();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "never mind, I'll write it");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    release(Response.json({ text: HEARD }));
    await settle();
    expect(box().value).toBe("never mind, I'll write it");
    expect(mic().getAttribute("aria-busy")).toBeNull();
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

  it("quietly keeps the on-device text when no service can help", async () => {
    transcribe.mockImplementation(async () => Response.json({ error: "No transcription service is set up.", reason: "no-service" }, { status: 409 }));
    await dictate("draft the lunch post");
    await stopWithRecording();
    expect(box().value).toBe("draft the lunch post");
    expect(host.querySelector("[data-voice-note]")).toBeNull();
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
