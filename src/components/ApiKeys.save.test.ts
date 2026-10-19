// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as store from "@/state/store";
import { ApiKeyRow } from "./ApiKeys";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const settle = async () => {
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
};

function mountXaiRow() {
  const config = { ...store.initialState.config, xai: { configured: true } } as store.ConfigStatus;
  vi.spyOn(store, "useStore").mockReturnValue({
    state: { ...store.initialState, config },
    dispatch: vi.fn(),
    flushBotPatches: vi.fn(),
    refreshInstances: vi.fn(),
    refreshModels: vi.fn(),
  });
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    const body = url === "/api/keys/test" ? { ok: true, check: "models", models: ["fixture-model"] } : config;
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(createElement(ApiKeyRow, { section: "xai", testProvider: "xai" })));
  const input = host.querySelector("input")!;
  const type = (text: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
  };
  const press = (key: string) => flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
  const blur = () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  const saves = () => calls.filter((call) => call.url === "/api/config" && call.method === "PUT").length;
  const tests = () => calls.filter((call) => call.url === "/api/keys/test").length;
  return { root, input, type, press, blur, saves, tests };
}

describe("saving a key row", () => {
  it("saves and tests the key once when Enter is followed by the field losing focus", async () => {
    const row = mountXaiRow();
    row.type("fixture-draft-key");
    row.press("Enter");
    row.blur();
    await settle();
    row.blur();
    await vi.waitFor(() => expect(row.input.value).toBe(""));
    row.blur();
    await settle();
    expect(row.saves()).toBe(1);
    expect(row.tests()).toBe(1);
    row.root.unmount();
  });

  it("saves the key once when the field loses focus without Enter", async () => {
    const row = mountXaiRow();
    row.type("fixture-draft-key");
    row.blur();
    row.blur();
    await vi.waitFor(() => expect(row.input.value).toBe(""));
    row.blur();
    await settle();
    expect(row.saves()).toBe(1);
    expect(row.tests()).toBe(1);
    row.root.unmount();
  });
});
