// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus } from "@/state/store";

const fixture = vi.hoisted(() => ({ box: { configured: false } as ConfigStatus["box"] }));
vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({ state: { ...actual.initialState, config: { ...actual.initialState.config, box: fixture.box } }, dispatch: vi.fn() }),
  };
});

const { CloudComputersRow } = await import("./ApiKeys");

let root: Root | null = null;
const mount = () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(CloudComputersRow)));
};
const text = () => document.body.textContent ?? "";

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
});

describe("Settings → Computer → Cloud computers", () => {
  it("asks for no Boat key", () => {
    for (const box of [{ configured: false }, { configured: true }, { configured: true, included: true }]) {
      fixture.box = box;
      mount();
      expect(text()).toBe("");
      root!.unmount();
      document.body.innerHTML = "";
    }
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
