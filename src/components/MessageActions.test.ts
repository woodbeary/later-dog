// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageActions } from "./MessageActions";

type Props = Parameters<typeof MessageActions>[0];

let root: Root | null = null;
const render = (props: Partial<Omit<Props, "children">> = {}) => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(MessageActions, {
    side: "bot",
    ...props,
    children: [
      createElement("button", { type: "button", key: "copy" }, "copy"),
      createElement("button", { type: "button", key: "reply" }, "reply"),
    ],
  })));
  return document.querySelector<HTMLElement>('[data-testid="message-actions"]')!;
};
const more = () => document.querySelector<HTMLButtonElement>('button[aria-label="Message actions"]');
const items = () => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
});

describe("MessageActions", () => {
  it("shows its buttons straight away on hover, with no handle to open first", () => {
    const row = render();
    expect([...row.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["copy", "reply"]);
    expect(row.className).toContain("group-hover:opacity-100");
    expect(row.className).toContain("opacity-0");
    expect(more()).toBeNull();
  });

  it("keeps the rest under More, which closes once an item is picked", () => {
    const pin = vi.fn();
    const row = render({ more: [{ key: "pin", label: "Pin to top", onSelect: pin }, { key: "retry", label: "Retry", onSelect: () => {} }] });
    expect(items()).toEqual([]);
    flushSync(() => more()!.click());
    expect(items()).toEqual(["Pin to top", "Retry"]);
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.parentElement).toBe(document.body);
    expect(menu.className).toContain("fixed z-[100]");
    expect(row.contains(menu)).toBe(false);
    expect(document.activeElement).toBe(menu.querySelector('[role="menuitem"]'));
    expect(row.getAttribute("data-open")).toBe("true");
    flushSync(() => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    expect(pin).toHaveBeenCalledOnce();
    expect(more()!.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the portaled menu open for inside presses and closes for outside presses", () => {
    render({ more: [{ key: "pin", label: "Pin to top", onSelect: () => {} }] });
    flushSync(() => more()!.click());
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    flushSync(() => menu.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(more()?.getAttribute("aria-expanded")).toBe("true");
    flushSync(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(more()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("stays shown while a control must remain reachable", () => {
    const row = render({ forceOpen: true });
    expect(row.getAttribute("data-open")).toBe("true");
    expect(row.className).not.toContain("opacity-0");
  });

  it("puts the first button nearest the bubble on both sides", () => {
    expect(render({ side: "user" }).className).toContain("flex-row-reverse");
    root!.unmount();
    document.body.innerHTML = "";
    expect(render({ side: "bot" }).className).not.toContain("flex-row-reverse");
  });
});
