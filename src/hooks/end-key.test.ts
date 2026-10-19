// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { endKeyScrolls, scrollKeyLeavesBottom } from "./use-transcript-viewport";

const press = (key: string, extra: Partial<KeyboardEvent> = {}) =>
  ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, ...extra });

describe("the End key", () => {
  it("scrolls the chat to the bottom from the page or an empty composer", () => {
    expect(endKeyScrolls(press("End"), document.body)).toBe(true);
    const empty = document.createElement("textarea");
    expect(endKeyScrolls(press("End"), empty)).toBe(true);
  });

  it("leaves End alone while you are typing, and with any modifier", () => {
    const typing = document.createElement("textarea");
    typing.value = "half a thought";
    expect(endKeyScrolls(press("End"), typing)).toBe(false);
    expect(endKeyScrolls(press("End"), document.createElement("input"))).toBe(false);
    expect(endKeyScrolls(press("End", { shiftKey: true }), document.body)).toBe(false);
    expect(endKeyScrolls(press("End", { metaKey: true }), document.body)).toBe(false);
    expect(endKeyScrolls(press("Home"), document.body)).toBe(false);
    expect(endKeyScrolls(press("End", { defaultPrevented: true }), document.body)).toBe(false);
  });
});

describe("scroll keys that leave the bottom of a transcript", () => {
  const scrollable = (height: number) => {
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "scrollHeight", { value: height });
    Object.defineProperty(scroller, "clientHeight", { value: 400 });
    document.body.append(scroller);
    return scroller;
  };

  it("counts ArrowUp only from the page or inside a transcript that can scroll", () => {
    const scroller = scrollable(2_000);
    const row = document.createElement("p");
    scroller.append(row);
    const header = document.createElement("button");
    document.body.append(header);
    expect(scrollKeyLeavesBottom(press("ArrowUp"), row, scroller)).toBe(true);
    expect(scrollKeyLeavesBottom(press("ArrowUp"), document.body, scroller)).toBe(true);
    expect(scrollKeyLeavesBottom(press("ArrowUp", { altKey: true }), header, scroller)).toBe(false);
    expect(scrollKeyLeavesBottom(press("ArrowUp"), header, scroller)).toBe(false);
    expect(scrollKeyLeavesBottom(press("ArrowUp", { defaultPrevented: true }), row, scroller)).toBe(false);
    expect(scrollKeyLeavesBottom(press("ArrowUp"), scrollable(300), scroller)).toBe(false);
    expect(scrollKeyLeavesBottom(press("ArrowUp"), document.body, scrollable(300))).toBe(false);
  });

  it("leaves a textarea's ArrowUp to the caret", () => {
    const scroller = scrollable(2_000);
    const editing = document.createElement("textarea");
    scroller.append(editing);
    expect(scrollKeyLeavesBottom(press("ArrowUp"), editing, scroller)).toBe(false);
  });
});
