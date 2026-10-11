// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarPopoverMenu } from "./SidebarPopoverMenu";

let root: Root | null = null;
const openAt = (bottom: number, align?: "start" | "end", covered = 0) => {
  const list = document.createElement("div");
  list.style.overflowY = "auto";
  list.style.scrollPaddingBottom = `${covered}px`;
  document.body.append(list);
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 600 } as DOMRect);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(120);
  root = createRoot(list);
  flushSync(() => root!.render(createElement(SidebarPopoverMenu, {
    items: [{ key: "retry", label: "Retry", onSelect: () => {} }],
    ariaLabel: "More",
    placement: "auto",
    align,
    renderTrigger: () => "more",
  })));
  const trigger = list.querySelector("button")!;
  vi.spyOn(trigger.parentElement!, "getBoundingClientRect").mockReturnValue({ top: bottom - 24, bottom } as DOMRect);
  flushSync(() => trigger.click());
  return list.querySelector<HTMLElement>('[role="menu"]')!.className;
};

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("a menu beside a message", () => {
  it("opens below when there is room", () => {
    expect(openAt(200)).toContain("top-full");
  });

  it("opens above at the foot of the list, so the last message's menu is never cut off", () => {
    const menu = openAt(580);
    expect(menu).toContain("bottom-full");
    expect(menu).not.toContain("top-full");
  });

  it("counts the strip a floating composer covers as no room", () => {
    expect(openAt(440, "end", 100)).toContain("bottom-full");
    root!.unmount();
    document.body.innerHTML = "";
    expect(openAt(440)).toContain("top-full");
  });

  it("lines up with the side its trigger is on", () => {
    expect(openAt(200)).toContain("right-0");
    root!.unmount();
    document.body.innerHTML = "";
    expect(openAt(200, "start")).toContain("left-0");
  });
});
