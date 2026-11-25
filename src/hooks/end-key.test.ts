// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { endKeyScrolls, scrollKeyLeavesBottom } from "./use-transcript-viewport";

const press = (key: string, extra: Partial<KeyboardEvent> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  defaultPrevented: false,
  ...extra,
});

describe("the End key", () => {
  it("scrolls the chat to the bottom from the page or an empty composer", () => {
    expect(endKeyScrolls(press("End"), document.body)).toBe(true);
    const empty = document.createElement("textarea");
    const composer = document.createElement("div");
    composer.dataset.composerSurface = "";
    composer.append(empty);
    expect(endKeyScrolls(press("End"), empty)).toBe(true);
  });

  it("keeps End inside the conversation instead of jumping from sidebar and menu controls", () => {
    const scroller = document.createElement("div");
    const row = document.createElement("p");
    const transcriptButton = document.createElement("button");
    scroller.append(row, transcriptButton);
    const sidebarButton = document.createElement("button");
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const menuRow = document.createElement("span");
    menu.append(menuRow);
    expect(endKeyScrolls(press("End"), row, scroller)).toBe(true);
    expect(endKeyScrolls(press("End"), scroller, scroller)).toBe(true);
    expect(endKeyScrolls(press("End"), sidebarButton, scroller)).toBe(false);
    expect(endKeyScrolls(press("End"), menuRow, scroller)).toBe(false);
    expect(endKeyScrolls(press("End"), transcriptButton, scroller)).toBe(false);
    expect(endKeyScrolls(press("End"), document.createElement("textarea"), scroller)).toBe(false);
    expect(endKeyScrolls(press("End"), null, scroller)).toBe(false);
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
    expect(scrollKeyLeavesBottom(press("ArrowUp", { defaultPrevented: true }), row, scroller)).toBe(
      false,
    );
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
