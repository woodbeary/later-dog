// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { endKeyScrolls } from "./use-transcript-viewport";

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
