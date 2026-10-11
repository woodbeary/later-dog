// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus } from "@/state/store";

const fixture = vi.hoisted(() => ({
  box: { configured: false } as ConfigStatus["box"],
  api: vi.fn(),
}));
vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  return {
    ...actual,
    api: fixture.api,
    useStore: () => ({ state: { ...actual.initialState, config: { ...actual.initialState.config, box: fixture.box } }, dispatch: vi.fn() }),
  };
});

const { CloudComputersRow } = await import("./ApiKeys");

let root: Root | null = null;
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const mount = () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(CloudComputersRow)));
};
const text = () => document.body.textContent ?? "";
const button = () => document.querySelector("button");
const field = () => document.querySelector<HTMLInputElement>("input[type=password]");
const press = (node: HTMLElement) => flushSync(() => node.click());
const type = (input: HTMLInputElement, value: string) => flushSync(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

beforeEach(() => {
  fixture.box = { configured: false };
  fixture.api.mockReset();
  fixture.api.mockResolvedValue({ box: { configured: true } });
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
});

describe("Settings → Computer → Boat", () => {
  it("is one plain line with the key behind a button", () => {
    mount();
    expect(text()).toBe("BoatCloud computers on your own Boat account. Boat charges for use.Add key");
    expect(field()).toBeNull();
  });

  it("opens a focused field with the key guide, and Cancel closes it without saving", () => {
    mount();
    press(button()!);
    expect(document.activeElement).toBe(field());
    expect(document.querySelector("a")!.getAttribute("href")).toBe("https://docs.boat.dev/api-keys");
    expect(text()).toContain("How to get a key");
    expect(text()).not.toMatch(/optional|after its trial/i);

    type(field()!, "bt_live_123");
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button()!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(button()!.textContent).toBe("Cancel");
    press(button()!);
    expect(field()).toBeNull();
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("saves the key and closes", async () => {
    mount();
    press(button()!);
    type(field()!, "bt_live_123");
    flushSync(() => field()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await flush();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ box: { token: "bt_live_123" } }) });
    expect(field()).toBeNull();
  });

  it("says a saved key is saved, and changing it offers Clear", () => {
    fixture.box = { configured: true };
    mount();
    expect(text()).toBe("BoatKey saved.Change key");
    press(button()!);
    expect(field()!.placeholder).toContain("paste to replace");
    expect(Array.from(document.querySelectorAll("button")).map((node) => node.textContent)).toEqual(["Cancel", "Clear"]);
  });

  it("says when a Cloud plan includes the computers", () => {
    fixture.box = { configured: true, included: true };
    mount();
    expect(text()).toBe("BoatIncluded with your Cloud planAdd key");
  });

  it("shows later.dog's own computers without asking for a key, and leaves a trial to the trial row", () => {
    fixture.box = { configured: true, provider: "laterdog" };
    mount();
    expect(text()).toBe("Your own computersOn your Cloudflare account.");
    root!.unmount();
    document.body.innerHTML = "";
    fixture.box = { configured: true, provider: "laterdog", trial: true };
    mount();
    expect(text()).toBe("");
  });
});
