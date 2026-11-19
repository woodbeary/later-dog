import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { viewerPage } from "../src/viewer";
import { CLIPBOARD_WORDS, NOTE_SHOWN_MS, PASTE_SETTLE_MS } from "../src/viewer-clipboard";

const ALT_LEFT = 0xffe9;
const SUPER_LEFT = 0xffeb;
const SUPER_RIGHT = 0xffec;
const CONTROL_LEFT = 0xffe3;
const SHIFT_LEFT = 0xffe1;
const ENTER = 0xff0d;

type Sent = [number, boolean];
type Listener = (event: KeyEvent) => void;

interface KeyEvent {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  stopped: boolean;
  preventDefault(): void;
  stopImmediatePropagation(): void;
  stopPropagation(): void;
}

class FakeRFB {
  static made: FakeRFB[] = [];
  sent: Sent[] = [];
  pasted: string[] = [];
  listeners = new Map<string, ((event: { detail?: unknown }) => void)[]>();
  viewOnly = true;
  scaleViewport = false;
  resizeSession = true;
  background = "";
  qualityLevel = 0;
  compressionLevel = 0;
  constructor() {
    FakeRFB.made.push(this);
  }
  addEventListener(type: string, listener: (event: { detail?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string, detail?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ detail });
  }
  focus() {}
  sendKey(keysym: number, _code: string | null, down: boolean) {
    this.sent.push([keysym, down]);
  }
  clipboardPasteFrom(text: string) {
    this.pasted.push(text);
  }
  keyboard(event: KeyEvent) {
    if (event.code === "MetaLeft") return this.sendKey(ALT_LEFT, "MetaLeft", true);
    if (event.code === "MetaRight") return this.sendKey(SUPER_LEFT, "MetaRight", true);
    if (event.metaKey) {
      const keysym = event.key.codePointAt(0)!;
      this.sendKey(keysym, event.code, true);
      this.sendKey(keysym, event.code, false);
    }
  }
}

function key(code: string, keyName: string, modifiers: Partial<Pick<KeyEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat">> = {}): KeyEvent {
  const event: KeyEvent = {
    code, key: keyName, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, ...modifiers,
    defaultPrevented: false, stopped: false,
    preventDefault() { event.defaultPrevented = true; },
    stopImmediatePropagation() { event.stopped = true; },
    stopPropagation() { event.stopped = true; },
  };
  return event;
}

const cmdV = (modifiers: Partial<Pick<KeyEvent, "repeat">> = {}) => key("KeyV", "v", { metaKey: true, ...modifiers });

const settle = async () => {
  for (let round = 0; round < 20; round += 1) await Promise.resolve();
};

interface MacClipboard {
  text?: string;
  readRefused?: boolean;
  read?: () => Promise<string>;
  linkStatus?: number;
}

function openViewer(clipboard: MacClipboard = {}) {
  FakeRFB.made = [];
  const html = viewerPage({ name: "Rex", expiresAtMs: Date.now() + 3_600_000, nonce: "n" });
  const script = /<script type="module" nonce="n">([\s\S]*?)<\/script>/.exec(html)![1]!.replace(/^import RFB from "[^"]+";$/m, "const RFB = scope.RFB;");
  const elements = {
    screen: { textContent: "" },
    status: { textContent: "", dataset: {} as Record<string, string> },
    label: { textContent: "Connecting…" },
  };
  const listeners = new Map<string, { listener: Listener; capture: boolean }[]>();
  const window = {
    addEventListener: (type: string, listener: Listener, capture = false) => listeners.set(type, [...(listeners.get(type) ?? []), { listener, capture: capture === true }]),
  };
  const written: string[] = [];
  let reads = 0;
  const navigator = {
    clipboard: {
      readText: async () => {
        reads += 1;
        if (clipboard.read) return clipboard.read();
        if (clipboard.readRefused) throw new Error("not allowed");
        return clipboard.text ?? "";
      },
      writeText: async (text: string) => {
        written.push(text);
      },
    },
  };
  let focused = true;
  const document = { getElementById: (id: keyof typeof elements) => elements[id], hasFocus: () => focused };
  const status = clipboard.linkStatus ?? 200;
  const fetch = async () => ({ status, ok: status === 200, json: async () => ({ state: "running" }) });
  new Function("scope", "window", "document", "location", "navigator", "fetch", script)(
    { RFB: FakeRFB },
    window,
    document,
    { href: "https://cloud.test/desktop/cmp_rex/tok/" },
    navigator,
    fetch,
  );
  const rfb = () => FakeRFB.made.at(-1)!;
  const press = (event: KeyEvent) => {
    for (const { listener, capture } of listeners.get("keydown") ?? []) if (capture) listener(event);
    if (!event.stopped) rfb().keyboard(event);
    return event;
  };
  const release = (event: KeyEvent) => {
    for (const { listener } of listeners.get("keyup") ?? []) listener(event);
  };
  return {
    rfb, press, release, written,
    label: () => elements.label.textContent,
    reads: () => reads,
    focus: (now: boolean) => { focused = now; },
  };
}

function liveViewer(clipboard: MacClipboard = {}) {
  const viewer = openViewer(clipboard);
  viewer.rfb().fire("connect");
  return viewer;
}

const downs = (sent: Sent[]) => sent.filter(([, down]) => down).map(([keysym]) => keysym);
const codes = (text: string) => [...text].map((character) => character.codePointAt(0));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Cmd+V in the desktop's screen window", () => {
  it("types the Mac's clipboard into the focused field instead of sending Alt+V", async () => {
    const viewer = liveViewer({ text: "Code 4821" });
    viewer.press(key("MetaLeft", "Meta", { metaKey: true }));
    const paste = viewer.press(cmdV());
    await settle();
    expect(paste.stopped).toBe(true);
    expect(paste.defaultPrevented).toBe(true);
    const sent = viewer.rfb().sent;
    expect(sent.slice(0, 4)).toEqual([[ALT_LEFT, true], [ALT_LEFT, false], [SUPER_LEFT, false], [SUPER_RIGHT, false]]);
    expect(downs(sent.slice(4))).toEqual(codes("Code 4821"));
    expect(sent.filter(([keysym, down]) => keysym === 0x76 && down)).toEqual([]);
    expect(viewer.rfb().pasted).toEqual(["Code 4821"]);
    expect(viewer.label()).toBe(CLIPBOARD_WORDS.pasted);
    vi.advanceTimersByTime(NOTE_SHOWN_MS);
    expect(viewer.label()).toBe("Live");
  });

  it("presses and lets go of every key it types", async () => {
    const viewer = liveViewer({ text: "a@B" });
    viewer.press(cmdV());
    await settle();
    expect(viewer.rfb().sent).toEqual([[0x61, true], [0x61, false], [0x40, true], [0x40, false], [0x42, true], [0x42, false]]);
  });

  it("breaks lines with Shift and Return so a form is not sent halfway, and leaves off a last line break", async () => {
    const viewer = liveViewer({ text: "12 Oak St\r\nSpringfield\n" });
    viewer.press(cmdV());
    await settle();
    const sent = viewer.rfb().sent;
    const at = sent.findIndex(([keysym]) => keysym === SHIFT_LEFT);
    expect(sent.slice(at, at + 4)).toEqual([[SHIFT_LEFT, true], [ENTER, true], [ENTER, false], [SHIFT_LEFT, false]]);
    expect(sent.filter(([keysym, down]) => keysym === ENTER && down)).toHaveLength(1);
  });

  it("puts a very long text on the computer's clipboard and pastes it with Ctrl+V once it has settled", async () => {
    const long = "x".repeat(2500);
    const viewer = liveViewer({ text: long });
    viewer.press(cmdV());
    await settle();
    expect(viewer.rfb().pasted).toEqual([long]);
    expect(viewer.rfb().sent).toEqual([]);
    vi.advanceTimersByTime(PASTE_SETTLE_MS - 1);
    expect(viewer.rfb().sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(viewer.rfb().sent).toEqual([[CONTROL_LEFT, true], [0x76, true], [0x76, false], [CONTROL_LEFT, false]]);
    expect(viewer.label()).toBe(CLIPBOARD_WORDS.pasted);
  });

  it("says when the Mac's clipboard is empty or its access was refused, and types nothing", async () => {
    const empty = liveViewer({ text: "" });
    empty.press(cmdV());
    await settle();
    expect(empty.rfb().sent).toEqual([]);
    expect(empty.label()).toBe(CLIPBOARD_WORDS.nothingToPaste);

    const refused = liveViewer({ readRefused: true });
    refused.press(cmdV());
    await settle();
    expect(refused.rfb().sent).toEqual([]);
    expect(refused.label()).toBe(CLIPBOARD_WORDS.pasteRefused);
  });

  it("says the screen is not connected yet, and reads and types nothing, while it connects", async () => {
    const viewer = openViewer({ text: "4821" });
    const paste = viewer.press(cmdV());
    await settle();
    expect(paste.stopped).toBe(true);
    expect(viewer.reads()).toBe(0);
    expect(viewer.rfb().sent).toEqual([]);
    expect(viewer.rfb().pasted).toEqual([]);
    expect(viewer.label()).toBe(CLIPBOARD_WORDS.notConnected);
    vi.advanceTimersByTime(NOTE_SHOWN_MS);
    expect(viewer.label()).toBe("Connecting…");
  });

  it("types nothing when the screen drops while the Mac's clipboard is being read", async () => {
    let hand: (text: string) => void = () => {};
    const viewer = liveViewer({ read: () => new Promise((resolve) => { hand = resolve; }) });
    const first = viewer.rfb();
    viewer.press(cmdV());
    first.fire("disconnect");
    await settle();
    expect(viewer.label()).toBe("Reconnecting…");
    hand("4821");
    await settle();
    expect(first.sent).toEqual([]);
    expect(first.pasted).toEqual([]);
    expect(viewer.label()).toBe(CLIPBOARD_WORDS.notConnected);
  });

  it("presses no Ctrl+V when the screen drops before a long text has settled", async () => {
    const viewer = liveViewer({ text: "y".repeat(2500) });
    const first = viewer.rfb();
    viewer.press(cmdV());
    await settle();
    first.fire("disconnect");
    await settle();
    vi.advanceTimersByTime(PASTE_SETTLE_MS);
    expect(first.sent).toEqual([]);
    expect(viewer.label()).toBe(CLIPBOARD_WORDS.notConnected);
  });

  it("leaves the words of an ended link in place", async () => {
    const viewer = liveViewer({ text: "4821", linkStatus: 404 });
    viewer.rfb().fire("disconnect");
    await settle();
    const ended = viewer.label();
    expect(ended).toContain("ended");
    viewer.press(cmdV());
    await settle();
    expect(viewer.label()).toBe(ended);
  });

  it("pastes once when Cmd+V is held down", async () => {
    const viewer = liveViewer({ text: "4821" });
    viewer.press(cmdV());
    const repeats = [viewer.press(cmdV({ repeat: true })), viewer.press(cmdV({ repeat: true }))];
    await settle();
    expect(repeats.every((event) => event.stopped && event.defaultPrevented)).toBe(true);
    expect(viewer.reads()).toBe(1);
    expect(downs(viewer.rfb().sent)).toEqual(codes("4821"));
  });

  it("follows the Mac's keyboard layout: the key that types v pastes, wherever it is", async () => {
    const dvorak = liveViewer({ text: "4821" });
    const paste = dvorak.press(key("Period", "v", { metaKey: true }));
    const notPaste = dvorak.press(key("KeyV", "k", { metaKey: true }));
    await settle();
    expect(paste.stopped).toBe(true);
    expect(notPaste.stopped).toBe(false);
    expect(dvorak.reads()).toBe(1);

    const cyrillic = liveViewer({ text: "4821" });
    cyrillic.press(key("KeyV", "м", { metaKey: true }));
    await settle();
    expect(downs(cyrillic.rfb().sent)).toEqual(codes("4821"));
  });
});

describe("Cmd+C in the desktop's screen window", () => {
  it("copies what the computer last selected or copied to the Mac, sending no keys", async () => {
    const viewer = liveViewer();
    viewer.rfb().fire("clipboard", { text: "Order 7731 confirmed" });
    const copy = viewer.press(key("KeyC", "c", { metaKey: true }));
    await settle();
    expect(copy.stopped).toBe(true);
    expect(viewer.written).toEqual(["Order 7731 confirmed"]);
    expect(viewer.rfb().sent).toEqual([]);
    expect(viewer.label()).toBe(CLIPBOARD_WORDS.copied);
  });

  it("asks him to select text first when the computer has sent nothing", async () => {
    const viewer = liveViewer();
    viewer.press(key("KeyC", "c", { metaKey: true }));
    await settle();
    expect(viewer.written).toEqual([]);
    expect(viewer.label()).toBe(CLIPBOARD_WORDS.nothingToCopy);
  });

  it("copies nothing the computer put on its clipboard while the screen window was in the background", async () => {
    const viewer = liveViewer();
    viewer.rfb().fire("clipboard", { text: "Seen while watching" });
    viewer.focus(false);
    viewer.rfb().fire("clipboard", { text: "Typed by the dog" });
    viewer.focus(true);
    viewer.press(key("KeyC", "c", { metaKey: true }));
    await settle();
    expect(viewer.written).toEqual(["Seen while watching"]);
  });
});

describe("every other key in the screen window", () => {
  it("still reaches the computer the way it did, Cmd shortcuts included", () => {
    const viewer = liveViewer({ text: "4821" });
    viewer.press(key("MetaLeft", "Meta", { metaKey: true }));
    const selectAll = viewer.press(key("KeyA", "a", { metaKey: true }));
    const shifted = viewer.press(key("KeyV", "V", { metaKey: true, shiftKey: true }));
    expect(selectAll.stopped).toBe(false);
    expect(shifted.stopped).toBe(false);
    expect(viewer.rfb().sent).toEqual([[ALT_LEFT, true], [0x61, true], [0x61, false], [0x56, true], [0x56, false]]);
    expect(viewer.rfb().pasted).toEqual([]);
  });

  it("lets go only of what Cmd held, and holds nothing back once Cmd is up", async () => {
    const viewer = liveViewer({ text: "ok" });
    viewer.press(key("MetaRight", "Meta", { metaKey: true }));
    viewer.release(key("MetaRight", "Meta"));
    viewer.rfb().sent.length = 0;
    viewer.press(cmdV());
    await settle();
    expect(viewer.rfb().sent).toEqual([[0x6f, true], [0x6f, false], [0x6b, true], [0x6b, false]]);
  });

  it("sends no bare letters for Cmd shortcuts while Cmd stays down after a paste, and sends them again once Cmd is let go", async () => {
    const viewer = liveViewer({ text: "4821" });
    viewer.press(key("MetaLeft", "Meta", { metaKey: true }));
    viewer.press(cmdV());
    await settle();
    viewer.rfb().sent.length = 0;
    const selectAll = viewer.press(key("KeyA", "a", { metaKey: true }));
    expect(selectAll.stopped).toBe(true);
    expect(viewer.rfb().sent).toEqual([]);

    viewer.release(key("MetaLeft", "Meta"));
    viewer.press(key("MetaLeft", "Meta", { metaKey: true }));
    const again = viewer.press(key("KeyA", "a", { metaKey: true }));
    expect(again.stopped).toBe(false);
    expect(viewer.rfb().sent).toEqual([[ALT_LEFT, true], [0x61, true], [0x61, false]]);
  });
});
