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

function key(code: string, keyName: string, modifiers: Partial<Pick<KeyEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {}): KeyEvent {
  const event: KeyEvent = {
    code, key: keyName, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers,
    defaultPrevented: false, stopped: false,
    preventDefault() { event.defaultPrevented = true; },
    stopImmediatePropagation() { event.stopped = true; },
    stopPropagation() { event.stopped = true; },
  };
  return event;
}

const settle = async () => {
  for (let round = 0; round < 8; round += 1) await Promise.resolve();
};

function openViewer(clipboard: { text?: string; readRefused?: boolean } = {}) {
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
  const navigator = {
    clipboard: {
      readText: async () => {
        if (clipboard.readRefused) throw new Error("not allowed");
        return clipboard.text ?? "";
      },
      writeText: async (text: string) => {
        written.push(text);
      },
    },
  };
  const document = { getElementById: (id: keyof typeof elements) => elements[id] };
  const fetch = async () => ({ status: 200, ok: true, json: async () => ({ state: "running" }) });
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
  return { rfb, press, release, written, label: () => elements.label.textContent };
}

function liveViewer(clipboard: { text?: string; readRefused?: boolean } = {}) {
  const viewer = openViewer(clipboard);
  viewer.rfb().fire("connect");
  return viewer;
}

const downs = (sent: Sent[]) => sent.filter(([, down]) => down).map(([keysym]) => keysym);

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
    const paste = viewer.press(key("KeyV", "v", { metaKey: true }));
    await settle();
    expect(paste.stopped).toBe(true);
    expect(paste.defaultPrevented).toBe(true);
    const sent = viewer.rfb().sent;
    expect(sent.slice(0, 4)).toEqual([[ALT_LEFT, true], [ALT_LEFT, false], [SUPER_LEFT, false], [SUPER_RIGHT, false]]);
    expect(downs(sent.slice(4))).toEqual([..."Code 4821"].map((character) => character.codePointAt(0)));
    expect(sent.filter(([keysym, down]) => keysym === 0x76 && down)).toEqual([]);
    expect(viewer.rfb().pasted).toEqual(["Code 4821"]);
    expect(viewer.label()).toBe(CLIPBOARD_WORDS.pasted);
    vi.advanceTimersByTime(NOTE_SHOWN_MS);
    expect(viewer.label()).toBe("Live");
  });

  it("presses and lets go of every key it types", async () => {
    const viewer = liveViewer({ text: "a@B" });
    viewer.press(key("KeyV", "v", { metaKey: true }));
    await settle();
    expect(viewer.rfb().sent).toEqual([[0x61, true], [0x61, false], [0x40, true], [0x40, false], [0x42, true], [0x42, false]]);
  });

  it("breaks lines with Shift and Return so a form is not sent halfway, and leaves off a last line break", async () => {
    const viewer = liveViewer({ text: "12 Oak St\r\nSpringfield\n" });
    viewer.press(key("KeyV", "v", { metaKey: true }));
    await settle();
    const sent = viewer.rfb().sent;
    const at = sent.findIndex(([keysym]) => keysym === SHIFT_LEFT);
    expect(sent.slice(at, at + 4)).toEqual([[SHIFT_LEFT, true], [ENTER, true], [ENTER, false], [SHIFT_LEFT, false]]);
    expect(sent.filter(([keysym, down]) => keysym === ENTER && down)).toHaveLength(1);
  });

  it("puts a very long text on the computer's clipboard and pastes it with Ctrl+V once it has settled", async () => {
    const long = "x".repeat(2500);
    const viewer = liveViewer({ text: long });
    viewer.press(key("KeyV", "v", { metaKey: true }));
    await settle();
    expect(viewer.rfb().pasted).toEqual([long]);
    expect(viewer.rfb().sent).toEqual([]);
    vi.advanceTimersByTime(PASTE_SETTLE_MS);
    expect(viewer.rfb().sent).toEqual([[CONTROL_LEFT, true], [0x76, true], [0x76, false], [CONTROL_LEFT, false]]);
  });

  it("says when the Mac's clipboard is empty or its access was refused, and types nothing", async () => {
    const empty = liveViewer({ text: "" });
    empty.press(key("KeyV", "v", { metaKey: true }));
    await settle();
    expect(empty.rfb().sent).toEqual([]);
    expect(empty.label()).toBe(CLIPBOARD_WORDS.nothingToPaste);

    const refused = liveViewer({ readRefused: true });
    refused.press(key("KeyV", "v", { metaKey: true }));
    await settle();
    expect(refused.rfb().sent).toEqual([]);
    expect(refused.label()).toBe(CLIPBOARD_WORDS.pasteRefused);
  });

  it("types nothing while the screen is not connected", async () => {
    const viewer = openViewer({ text: "4821" });
    viewer.press(key("KeyV", "v", { metaKey: true }));
    await settle();
    expect(viewer.rfb().sent).toEqual([]);
    expect(viewer.rfb().pasted).toEqual([]);
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
    viewer.press(key("KeyV", "v", { metaKey: true }));
    await settle();
    expect(viewer.rfb().sent).toEqual([[0x6f, true], [0x6f, false], [0x6b, true], [0x6b, false]]);
  });
});
