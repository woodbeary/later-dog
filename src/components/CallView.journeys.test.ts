// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createElement, useReducer, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot } from "@/state/store";

type Desktop = { capabilities: DesktopCapabilities; ready: boolean };
const fixture = vi.hoisted(() => ({ desktop: null as Desktop | null }));
vi.mock("./DesktopCapabilities", async (importOriginal) => {
  const real = await importOriginal<typeof import("./DesktopCapabilities")>();
  return {
    ...real,
    useDesktopCapabilities: () => {
      const detected = real.useDesktopCapabilities();
      return fixture.desktop ?? detected;
    },
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const stored = new Map<string, string>();
const storage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
  removeItem: (key: string) => void stored.delete(key),
};
vi.stubGlobal("localStorage", storage);

const { CallButton } = await import("./CallView");
const { LiveCallBar } = await import("./LiveCallBar");
const { BotEditorStore, initialState, reducer } = await import("@/state/store");
const { currentCall, endCall } = await import("@/lib/call");
const { configureLiveMedia, liveMedia, resetLiveMedia } = await import("@/lib/live-call-media");
const { cacheDesktopCapabilities, initialDesktopCapabilities } = await import("@/lib/desktop");

const { desktopCapabilities } = createRequire(import.meta.url)("../../electron/capabilities.cjs") as {
  desktopCapabilities(options: { platform: string; remote?: boolean; remoteSpeech?: boolean; env?: Record<string, string>; homeDir?: string }): DesktopCapabilities;
};
const PRELOAD = readFileSync(join(process.cwd(), "electron", "preload.cjs"), "utf8");
const LOCAL_ORIGIN = "http://127.0.0.1:8799";
const CLOUD_ORIGIN = "https://laterdog-t-0123456789ab.fly.dev";

type Bridge = NonNullable<Window["laterdog"]>;
type Platform = "darwin" | "win32" | "linux";
let invoked: Array<{ channel: string; args: unknown[] }>;
let pageMic: "allowed" | "refused" | undefined;
let liveKey: string;
let microphone: "allowed" | "refused";

function desktopApp(platform: Platform, page: "this-computer" | "my-cloud"): { bridge: Bridge; desktop: Desktop } {
  let bridge: Bridge | undefined;
  runInNewContext(PRELOAD, {
    process: { platform, argv: [`--laterdog-local-origin=${LOCAL_ORIGIN}`] },
    location: { origin: page === "this-computer" ? LOCAL_ORIGIN : CLOUD_ORIGIN },
    TextEncoder,
    localStorage: { getItem: () => null },
    require: () => ({
      webUtils: {},
      contextBridge: { exposeInMainWorld: (_name: string, value: Bridge) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, invoke: async (channel: string, ...args: unknown[]) => answer(channel, args) },
    }),
  });
  const capabilities = desktopCapabilities({ platform, remote: page === "my-cloud", remoteSpeech: page === "my-cloud", env: {}, homeDir: "/Users/ada" });
  return { bridge: bridge!, desktop: { capabilities, ready: true } };
}
async function answer(channel: string, args: unknown[]): Promise<unknown> {
  invoked.push({ channel, args });
  if (channel === "perm:status") return pageMic === undefined ? {} : { pageMic };
  if (channel === "desktop:capabilities") return fixture.desktop?.capabilities;
  return undefined;
}
function open(app: { bridge: Bridge; desktop: Desktop }) {
  (window as { laterdog?: Bridge }).laterdog = app.bridge;
  fixture.desktop = app.desktop;
  cacheDesktopCapabilities(app.desktop.capabilities);
}

const ada: Bot = {
  id: "ada", threadId: "thread-ada", name: "Ada", title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [], voice: "voice-1",
  modelSelection: { instanceId: "claude", model: "m" },
};
const noKey = { configured: false, voice: "marin", readTypedReplies: true, idleMinutes: 5 };
const withKey = { ...noKey, configured: true };
const CLOUD = { cloudHome: true, tts: { configured: true, ready: true, voice: "preset", included: true }, live: noKey } as AppState["config"];
const CLOUD_WITH_LIVE = { ...CLOUD, live: withKey } as AppState["config"];
const SERVER_WITH_LIVE = { tts: { configured: true, ready: true, voice: "preset" }, live: withKey } as AppState["config"];
const THIS_COMPUTER = { tts: { configured: true, ready: true, voice: "voice-1", included: true }, live: noKey } as AppState["config"];
const NO_VOICE = { tts: { configured: false, ready: false, voice: "" }, live: noKey } as AppState["config"];
const KEY_FORM = "Live calls use OpenAI GPT-Live";
const KEY_FIELD = 'input[aria-label="OpenAI API key for Live calls"]';
const APP_REFUSED = "The app didn't let this page use the microphone. Open it in your web browser to make the Live call.";

function Page({ config, children }: { config: AppState["config"]; children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { ...initialState, config, bots: [ada] });
  const value = { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  return createElement(BotEditorStore, { value, children });
}

let root: Root;
let container: HTMLElement;
let requests: Array<{ path: string; method: string; body: unknown }>;
let getUserMedia: ReturnType<typeof vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>>;
const track = { enabled: true, stop() {} };
const createPeer = () => ({
  iceGatheringState: "complete", connectionState: "new", localDescription: { sdp: "v=0" },
  addTrack() {}, createDataChannel: () => ({ close() {} }), createOffer: async () => ({ type: "offer", sdp: "v=0" }),
  setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close() {},
}) as unknown as RTCPeerConnection;

function chat(config: AppState["config"]) {
  flushSync(() => root.render(createElement(Page, {
    config,
    children: [
      createElement(CallButton, { key: "call", bot: ada }),
      createElement(LiveCallBar, { key: "bar", bot: ada }),
    ],
  })));
}
const callButton = () => container.querySelector<HTMLButtonElement>("[data-call-button]");
const press = (element: Element | null) => {
  if (!element) throw new Error("nothing to press");
  flushSync(() => (element as HTMLElement).click());
};
const text = () => container.textContent ?? "";
const nonGets = () => requests.filter((request) => request.method !== "GET").map(({ path, method }) => `${method} ${path}`);

function expectNoKeyAsked() {
  expect(text()).not.toContain(KEY_FORM);
  expect(container.querySelector(KEY_FIELD)).toBeNull();
  expect(invoked.map(({ channel }) => channel)).not.toContain("credential:set");
  expect(requests.filter(({ path }) => path === "/api/config")).toEqual([]);
}

function expectTakeTurnsCall() {
  const button = callButton();
  expect(button?.getAttribute("aria-label")).toBe("Start voice chat");
  expect(button?.dataset.callRoute).toBe("turns");
  press(button);
  expect(currentCall()).toBe("ada");
  expect(liveMedia().phase).toBe("idle");
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(nonGets()).toEqual([]);
  expectNoKeyAsked();
}

function expectUnavailable(reason: string) {
  const button = callButton();
  expect(button?.getAttribute("aria-label")).toBe("Voice call unavailable");
  press(button);
  const help = container.querySelector('[role="group"][aria-label="Voice call unavailable"]');
  expect(help?.textContent).toContain("Voice call unavailable");
  expect(help?.textContent).toContain(reason);
  expect(currentCall()).toBeNull();
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(nonGets()).toEqual([]);
  expectNoKeyAsked();
}

beforeEach(() => {
  vi.stubGlobal("localStorage", storage);
  stored.clear();
  fixture.desktop = null;
  delete (window as { laterdog?: Bridge }).laterdog;
  cacheDesktopCapabilities(initialDesktopCapabilities());
  requests = [];
  invoked = [];
  pageMic = undefined;
  liveKey = "";
  microphone = "allowed";
  vi.stubGlobal("fetch", async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ path, method, body });
    if (path === "/api/live/session" && method === "POST") {
      if (!liveKey) return new Response(JSON.stringify({ error: "Add an OpenAI API key to use Live calls.", needsKey: true }), { status: 409 });
      return new Promise<Response>(() => {});
    }
    return new Response(JSON.stringify({ error: "not here" }), { status: 404 });
  });
  getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => {
    if (microphone === "refused") throw new DOMException("Permission denied", "NotAllowedError");
    return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  });
  configureLiveMedia({ getUserMedia, createPeer });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  resetLiveMedia();
  endCall();
  fixture.desktop = null;
  delete (window as { laterdog?: Bridge }).laterdog;
  vi.unstubAllGlobals();
});

describe("one voice button in a one-to-one chat", () => {
  it("on the Cloud home in the Mac app, takes turns with the included voice and this Mac's speech recognition, with no key asked for", () => {
    open(desktopApp("darwin", "my-cloud"));
    expect(typeof window.laterdog?.speechStart).toBe("function");
    chat(CLOUD);
    expectTakeTurnsCall();
  });

  it("on this Mac, takes turns with the included voice even when a Live key is saved", () => {
    open(desktopApp("darwin", "this-computer"));
    chat({ ...THIS_COMPUTER, live: withKey } as AppState["config"]);
    expectTakeTurnsCall();
  });

  it("shows no mode menu or chevron next to the button", () => {
    open(desktopApp("darwin", "this-computer"));
    chat(THIS_COMPUTER);
    expect(container.querySelector('[aria-label="Call mode"]')).toBeNull();
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelectorAll("[data-call-button]")).toHaveLength(1);
  });

  it.each(["win32", "linux"] as const)("on the Cloud home in the %s app with no Live key, says Voice call unavailable in plain words", (platform) => {
    open(desktopApp(platform, "my-cloud"));
    chat(CLOUD);
    expectUnavailable("Voice calls need the later.dog Mac app.");
  });

  it("in a browser on the Cloud home with no Live key, says Voice call unavailable and asks for nothing", () => {
    chat(CLOUD);
    expectUnavailable("Voice calls need the later.dog Mac app.");
  });

  it("on this Mac with no voice to speak with, offers Set up voice and never a key popover", () => {
    open(desktopApp("darwin", "this-computer"));
    chat(NO_VOICE);
    expectUnavailable("Ada doesn't have a voice to speak with yet.");
    expect(container.querySelector("[data-voice-setup-open]")?.textContent).toBe("Set up voice");
  });

  it.each(["win32", "linux"] as const)("in the %s app, a saved Live key makes the button a Live call", async (platform) => {
    liveKey = "sk-saved";
    open(desktopApp(platform, "my-cloud"));
    chat(CLOUD_WITH_LIVE);
    const button = callButton();
    expect(button?.getAttribute("aria-label")).toBe("Start voice chat");
    expect(button?.dataset.callRoute).toBe("live");
    press(button);
    await vi.waitFor(() => expect(requests.filter(({ path }) => path === "/api/live/session")).toHaveLength(1));
    expect(liveMedia()).toMatchObject({ phase: "starting", botId: "ada", threadId: "thread-ada" });
    await vi.waitFor(() => expect(text()).toContain("Live with Ada"));
    expectNoKeyAsked();
  });

  it("when the server has lost its Live key, says Voice call unavailable instead of asking for one", async () => {
    open(desktopApp("win32", "my-cloud"));
    chat(CLOUD_WITH_LIVE);
    press(callButton());
    await vi.waitFor(() => expect(text()).toContain("Voice call unavailable"));
    expect(liveMedia()).toMatchObject({ phase: "failed", notice: "Voice call unavailable" });
    expectNoKeyAsked();
  });

  it.each([
    ["the Cloud home in a Windows app that refused it", "win32", CLOUD_WITH_LIVE, "refused"],
    ["another server in the Linux app", "linux", SERVER_WITH_LIVE, "refused"],
  ] as const)("on %s, a refused microphone says so with Open in browser, and no key is asked for", async (_where, platform, config, answer) => {
    liveKey = "sk-saved";
    microphone = "refused";
    pageMic = answer;
    open(desktopApp(platform, "my-cloud"));
    chat(config);
    press(callButton());
    await vi.waitFor(() => expect(text()).toContain(APP_REFUSED));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(Array.from(container.querySelectorAll("button"), (button) => button.textContent?.trim())).toContain("Open in browser");
    expect(nonGets()).toEqual([]);
    expectNoKeyAsked();
  });

  it("in a browser with no microphone support and a Live key, says how to make the call", async () => {
    liveKey = "sk-saved";
    resetLiveMedia();
    expect(globalThis.navigator.mediaDevices).toBeUndefined();
    chat(SERVER_WITH_LIVE);
    press(callButton());
    await vi.waitFor(() => expect(text()).toContain("Live calls need a microphone, and this window can't use one. Open later.dog at a secure https address to make the call."));
    expect(text()).not.toContain("WebRTC");
    expect(nonGets()).toEqual([]);
    expectNoKeyAsked();
  });

  it("turns into Hang up during the call and ends it", () => {
    open(desktopApp("darwin", "this-computer"));
    chat(THIS_COMPUTER);
    press(callButton());
    expect(callButton()?.getAttribute("aria-label")).toBe("Hang up on Ada");
    press(callButton());
    expect(currentCall()).toBeNull();
    expect(callButton()?.getAttribute("aria-label")).toBe("Start voice chat");
  });

  it("stays in place but can't be pressed while another dog is on a Live call in this window", async () => {
    liveKey = "sk-saved";
    open(desktopApp("win32", "my-cloud"));
    getUserMedia.mockImplementation(() => new Promise<MediaStream>(() => {}));
    const { startLiveCall } = await import("@/lib/live-call-media");
    void startLiveCall({ botId: "juniper", threadId: "thread-juniper" });
    chat(CLOUD_WITH_LIVE);
    const button = callButton();
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-label")).toBe("On a Live call");
  });
});
