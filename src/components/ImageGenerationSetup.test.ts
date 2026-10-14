// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: { config: { imageGen: { configured: false } } }, dispatch: fixture.dispatch }) }));
import { ImageGenerationSetup } from "./ApiKeys";

let root: Root;
let host: HTMLDivElement;
const ready = vi.fn();
const key = "fixture-image-key";
const configured = { imageGen: { configured: true, provider: "openai" } };
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.api.mockReset();
  fixture.dispatch.mockReset();
  ready.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(ImageGenerationSetup, { onReady: ready })));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete window.laterdog;
  vi.unstubAllGlobals();
});
const enter = () => act(() => {
  const input = host.querySelector("input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, key);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const save = () => act(() => host.querySelector<HTMLButtonElement>("button")!.click());

describe("image key setup", () => {
  it("uses the secure desktop credential slot and clears the entry", async () => {
    const setCredential = vi.fn(async () => configured);
    window.laterdog = { setCredential } as unknown as NonNullable<Window["laterdog"]>;
    enter();
    save();
    await settle();
    expect(setCredential).toHaveBeenCalledWith("openaiImageApiKey", key);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: configured });
    expect(host.querySelector("input")!.value).toBe("");
    expect(host.textContent).not.toContain(key);
    expect(ready).toHaveBeenCalledOnce();
  });

  it("supports the authenticated web configuration path", async () => {
    fixture.api.mockResolvedValue(configured);
    enter();
    save();
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ imageGen: { key } }) });
    expect(ready).toHaveBeenCalledOnce();
  });
});
