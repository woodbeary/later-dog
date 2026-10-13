// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./Avatar", async (importOriginal) => ({
  ...await importOriginal<typeof import("./Avatar")>(),
  DogAvatar: ({ state }: { state?: string }) => createElement("span", { "data-dog": state }),
}));

const { WakeDog, WakingDog } = await import("./WakeDog");

let root: Root;
let host: HTMLDivElement;
const onWake = vi.fn();

const show = (props: { busy?: boolean; hint?: string; children?: ReactNode }) => act(async () => {
  root.render(createElement(WakeDog, { color: "green", label: "Wake Scout's computer", onWake, ...props }));
});
const dog = () => host.querySelector("button")!;
const describedBy = () => (dog().getAttribute("aria-describedby") ?? "").split(" ")
  .map((id) => document.getElementById(id)?.textContent ?? "");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onWake.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the sleeping dog you tap to wake", () => {
  it("is one real button named for what it does, with the dog asleep inside and the hint read with it", async () => {
    await show({ hint: "Tap to wake", children: createElement("div", null, "Computer is asleep") });
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(dog().type).toBe("button");
    expect(dog().getAttribute("aria-label")).toBe("Wake Scout's computer");
    expect(dog().getAttribute("aria-disabled")).toBeNull();
    expect(dog().querySelector('[aria-hidden="true"] [data-dog="sleeping"]')).not.toBeNull();
    expect(describedBy()).toEqual(["Computer is asleep", "Tap to wake"]);
    expect(host.textContent).toContain("Tap to wake");

    await act(async () => dog().click());
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("stays the same focused button while waking, ignores more taps, and shows the dog stirring then busy", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await show({ hint: "Tap to wake" });
    const button = dog();
    button.focus();

    await show({ busy: true, hint: "The first start takes about a minute." });
    expect(dog()).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(false);
    expect(host.querySelector("[data-wake-dog]")!.getAttribute("data-wake-dog")).toBe("waking");
    expect(button.querySelector('[data-dog="waking"]')).not.toBeNull();
    await act(async () => button.click());
    expect(onWake).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(900); });
    expect(button.querySelector('[data-dog="loading"]')).not.toBeNull();

    await show({ hint: "Tap to try again" });
    expect(button.querySelector('[data-dog="sleeping"]')).not.toBeNull();
    expect(button.getAttribute("aria-disabled")).toBeNull();
  });

  it("leaves out the description when there is nothing to describe", async () => {
    await show({});
    expect(dog().hasAttribute("aria-describedby")).toBe(false);
  });

  it("draws the same stirring dog on its own, for progress that has no button", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => root.render(createElement(WakingDog, { color: "green", waking: true })));
    expect(host.querySelector("[data-dog-state]")!.getAttribute("data-dog-state")).toBe("waking");
    expect(host.querySelector("button")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(900); });
    expect(host.querySelector("[data-dog-state]")!.getAttribute("data-dog-state")).toBe("loading");
  });
});
