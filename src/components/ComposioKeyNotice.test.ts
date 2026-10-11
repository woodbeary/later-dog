// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn(), saved: vi.fn() }));
vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  return { ...actual, api: fixture.api, useStore: () => ({ state: actual.initialState, dispatch: vi.fn() }) };
});

const { ComposioKeyNotice } = await import("./ApiKeys");

let root: Root | null = null;
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const mount = (remote = false) => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(ComposioKeyNotice, { remote, onSaved: fixture.saved })));
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
  fixture.api.mockReset();
  fixture.api.mockResolvedValue({ composio: { configured: true } });
  fixture.saved.mockReset();
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
});

describe("Apps → the Composio key", () => {
  it("is one plain line with the key behind a button", () => {
    mount();
    expect(text()).toBe("Gmail, Slack and many more connect through Composio. Add a Composio key to use them.Add key");
    expect(field()).toBeNull();
  });

  it("opens a focused field with the key guide, and Cancel closes it without saving", () => {
    mount();
    press(button()!);
    expect(document.activeElement).toBe(field());
    expect(document.querySelector("a")!.getAttribute("href")).toBe("https://dashboard.composio.dev");
    expect(text()).toContain("How to get a key");

    type(field()!, "ak_live_123");
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button()!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(button()!.textContent).toBe("Cancel");
    press(button()!);
    expect(field()).toBeNull();
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("saves the key, closes, and reloads the apps", async () => {
    mount();
    press(button()!);
    type(field()!, "ak_live_123");
    flushSync(() => field()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await flush();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ composio: { apiKey: "ak_live_123" } }) });
    expect(field()).toBeNull();
    expect(fixture.saved).toHaveBeenCalledOnce();
  });

  it("only explains it on a remote screen", () => {
    mount(true);
    expect(text()).toBe("Gmail, Slack and many more apps connect through Composio. Ask whoever runs this server to paste a Composio project key into Apps on that computer.");
    expect(button()).toBeNull();
  });
});
