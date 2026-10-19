import { describe, expect, it } from "vitest";

import { quoteSelectionShortcut } from "./CitationUI";

const key = (mods: Partial<KeyboardEvent> = {}) => ({ key: "l", code: "KeyL", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, ...mods });

describe("Command-L quotes the selected text in one step", () => {
  it("takes Command-L on a Mac and Ctrl-L elsewhere, nothing else", () => {
    expect(quoteSelectionShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(quoteSelectionShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(quoteSelectionShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(quoteSelectionShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(quoteSelectionShortcut(key({ metaKey: true, isComposing: true }), true)).toBe(false);
    expect(quoteSelectionShortcut(key({ metaKey: true, key: "k", code: "KeyK" }), true)).toBe(false);
  });
});
