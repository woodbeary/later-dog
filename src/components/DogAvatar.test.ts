// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BREEDS, DogFace, type DogMood } from "./DogAvatar";

const original = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
afterEach(() => {
  if (original) Object.defineProperty(Element.prototype, "getAnimations", original);
  else Reflect.deleteProperty(Element.prototype, "getAnimations");
  document.body.replaceChildren();
});

describe("dogs on screen at once", () => {
  it("loop on one shared clock, so the sidebar dog and the chat dog move in step, while one-shots play from their start", () => {
    const loop = { effect: { getTiming: () => ({ iterations: Infinity }) }, startTime: 1234 as number | null };
    const once = { effect: { getTiming: () => ({ iterations: 1 }) }, startTime: 1234 as number | null };
    const getAnimations = vi.fn(() => [loop, once]);
    Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, writable: true, value: getAnimations });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const face = (mood: DogMood) => flushSync(() => root.render(createElement(DogFace, { look: BREEDS.dog, color: "#009957", mood })));

    face("work");
    expect(getAnimations).toHaveBeenCalledWith({ subtree: true });
    expect(loop.startTime).toBe(0);
    expect(once.startTime).toBe(1234);

    loop.startTime = 99;
    face("think");
    expect(loop.startTime).toBe(0);
    root.unmount();
  });

  it("draws without the animation API", () => {
    Reflect.deleteProperty(Element.prototype, "getAnimations");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    flushSync(() => root.render(createElement(DogFace, { look: BREEDS.dog, color: "#009957", mood: "work" })));
    expect(container.querySelector("svg")?.getAttribute("data-mood")).toBe("work");
    root.unmount();
  });
});
