import { describe, expect, it, vi } from "vitest";
import { textBoxHeightCanChange, type MeasuredTextBox } from "./textarea-height";

const oneLine: MeasuredTextBox = { value: "Can you", lineHeight: 20, width: 600, smallest: true, tallest: false };
const threeLines: MeasuredTextBox = { value: "one\ntwo\nthree", lineHeight: 20, width: 600, smallest: false, tallest: false };
const full: MeasuredTextBox = { value: "1\n2\n3\n4\n5\n6\n7", lineHeight: 20, width: 600, smallest: false, tallest: true };
const typed = (last: MeasuredTextBox, value: string) => ({ value, lineHeight: last.lineHeight, width: last.width });

describe("textBoxHeightCanChange", () => {
  it("measures a box that has never been measured", () => {
    expect(textBoxHeightCanChange(null, typed(oneLine, ""), () => false)).toBe(true);
  });

  it("measures again when the line height or the width changed", () => {
    expect(textBoxHeightCanChange(oneLine, { ...typed(oneLine, oneLine.value), lineHeight: 24 }, () => false)).toBe(true);
    expect(textBoxHeightCanChange(oneLine, { ...typed(oneLine, oneLine.value), width: 480 }, () => false)).toBe(true);
  });

  it("leaves a box alone whose text, line height and width are the same", () => {
    const overflows = vi.fn(() => true);
    expect(textBoxHeightCanChange(threeLines, typed(threeLines, threeLines.value), overflows)).toBe(false);
    expect(overflows).not.toHaveBeenCalled();
  });

  it("leaves a one-line box alone while the text still fits, whatever was typed or removed", () => {
    expect(textBoxHeightCanChange(oneLine, typed(oneLine, "Can you also"), () => false)).toBe(false);
    expect(textBoxHeightCanChange(oneLine, typed(oneLine, "Can"), () => false)).toBe(false);
    expect(textBoxHeightCanChange(oneLine, typed(oneLine, ""), () => false)).toBe(false);
  });

  it("measures a one-line box once its text no longer fits", () => {
    expect(textBoxHeightCanChange(oneLine, typed(oneLine, "Can you\nalso"), () => true)).toBe(true);
  });

  it("measures a taller box whenever text was removed or changed in the middle, without asking whether it overflows", () => {
    const overflows = vi.fn(() => false);
    expect(textBoxHeightCanChange(threeLines, typed(threeLines, "one\ntwo"), overflows)).toBe(true);
    expect(textBoxHeightCanChange(threeLines, typed(threeLines, "one two\nthree"), overflows)).toBe(true);
    expect(textBoxHeightCanChange(threeLines, typed(threeLines, ""), overflows)).toBe(true);
    expect(overflows).not.toHaveBeenCalled();
  });

  it("measures a taller box that only gained text at its end when the text no longer fits", () => {
    expect(textBoxHeightCanChange(threeLines, typed(threeLines, "one\ntwo\nthree and"), () => false)).toBe(false);
    expect(textBoxHeightCanChange(threeLines, typed(threeLines, "one\ntwo\nthree\nfour"), () => true)).toBe(true);
  });

  it("leaves a box at its tallest alone while text is only added at its end", () => {
    const overflows = vi.fn(() => true);
    expect(textBoxHeightCanChange(full, typed(full, `${full.value}\n8`), overflows)).toBe(false);
    expect(overflows).not.toHaveBeenCalled();
    expect(textBoxHeightCanChange(full, typed(full, "1\n2"), overflows)).toBe(true);
  });
});
