import { describe, expect, it } from "vitest";

import { appShortcut, EMPTY_HISTORY, moveInHistory, stepThrough, visitSelection, type ShortcutEvent } from "./app-shortcuts";

const LETTER_CODES: Record<string, string> = { ",": "Comma", "[": "BracketLeft", "]": "BracketRight" };
const press = (key: string, mods: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
  key,
  code: LETTER_CODES[key] ?? (/^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : key),
  metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, defaultPrevented: false,
  ...mods,
});
const cmd = (key: string, mods: Partial<ShortcutEvent> = {}) => appShortcut(press(key, { metaKey: true, ...mods }), true)?.kind;

describe("desktop shortcuts", () => {
  it("maps every chord from the shortcut table on a Mac", () => {
    expect(cmd("k")).toBe("search");
    expect(cmd("f", { shiftKey: true })).toBe("search");
    expect(cmd("n")).toBe("newDog");
    expect(cmd(",")).toBe("settings");
    expect(cmd("i")).toBe("focusComposer");
    expect(cmd("b")).toBe("toggleSidebar");
    expect(cmd("[")).toBe("back");
    expect(cmd("]")).toBe("forward");
    expect(cmd("m", { shiftKey: true })).toBe("connectApps");
    expect(cmd("w", { shiftKey: true })).toBeUndefined();
    expect(cmd(",", { shiftKey: true })).toBe("dogPanel");
    expect(cmd("i", { shiftKey: true })).toBe("dogPanel");
    expect(appShortcut(press("∫", { code: "KeyB", metaKey: true, altKey: true }), true)?.kind).toBe("dogPanel");
    expect(appShortcut(press("3", { metaKey: true }), true)).toEqual({ kind: "dogAt", index: 2 });
    expect(appShortcut(press("ArrowUp", { altKey: true }), true)?.kind).toBe("previousDog");
    expect(appShortcut(press("ArrowDown", { altKey: true }), true)?.kind).toBe("nextDog");
  });

  it("follows the printed letter on Dvorak and AZERTY layouts, and the physical key when Option changes the letter", () => {
    expect(appShortcut(press("k", { code: "KeyV", metaKey: true }), true)?.kind).toBe("search");
    expect(appShortcut(press("b", { code: "KeyN", metaKey: true }), true)?.kind).toBe("toggleSidebar");
    expect(appShortcut(press("q", { code: "KeyA", metaKey: true }), true)).toBeNull();
    expect(appShortcut(press("∫", { code: "KeyB", metaKey: true, altKey: true }), true)?.kind).toBe("dogPanel");
  });

  it("uses Ctrl instead of Command on Windows and Linux, and ignores the other modifier", () => {
    expect(appShortcut(press("k", { ctrlKey: true }), false)?.kind).toBe("search");
    expect(appShortcut(press(",", { ctrlKey: true }), false)?.kind).toBe("settings");
    expect(appShortcut(press("k", { metaKey: true }), false)).toBeNull();
    expect(appShortcut(press("k", { ctrlKey: true }), true)).toBeNull();
  });

  it("leaves plain keys, handled events, typing and unknown chords alone", () => {
    expect(appShortcut(press("k"), true)).toBeNull();
    expect(cmd("k", { defaultPrevented: true })).toBeUndefined();
    expect(cmd("k", { isComposing: true })).toBeUndefined();
    expect(cmd("f")).toBeUndefined();
    expect(cmd("0")).toBeUndefined();
    expect(cmd("q", { shiftKey: true })).toBeUndefined();
    const textarea = { isContentEditable: false, closest: (selector: string) => selector.includes("textarea") ? {} : null };
    expect(appShortcut(press("ArrowUp", { altKey: true, target: textarea as unknown as EventTarget }), true)).toBeNull();
  });
});

describe("moving through the sidebar", () => {
  it("steps through the visible order and wraps at both ends", () => {
    const order = ["main", "pinned", "group", "dog"];
    expect(stepThrough(order, "pinned", 1)).toBe("group");
    expect(stepThrough(order, "dog", 1)).toBe("main");
    expect(stepThrough(order, "main", -1)).toBe("dog");
    expect(stepThrough(order, "hidden-dog", 1)).toBe("main");
    expect(stepThrough(order, "hidden-dog", -1)).toBe("dog");
    expect(stepThrough([], "dog", 1)).toBeUndefined();
  });

  it("goes back and forward through the chats you opened, skipping deleted ones", () => {
    let history = EMPTY_HISTORY;
    for (const id of ["a", "b", "b", "c"]) history = visitSelection(history, id);
    expect(history.entries).toEqual(["a", "b", "c"]);
    const back = moveInHistory(history, -1, (id) => id !== "b")!;
    expect(back.id).toBe("a");
    const forward = moveInHistory(back.history, 1, () => true)!;
    expect(forward.id).toBe("b");
    expect(moveInHistory({ entries: ["a"], index: 0 }, -1, () => true)).toBeNull();
    const branched = visitSelection(back.history, "d");
    expect(branched.entries).toEqual(["a", "d"]);
  });
});
