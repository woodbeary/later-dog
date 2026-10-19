// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { sections: [], bots: [], groups: [] }, dispatch: vi.fn() }),
}));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));

import { SectionPicker } from "./Sidebar";

let host: HTMLDivElement;
let root: Root;

const field = () => host.querySelector<HTMLInputElement>("[data-section-picker] input")!;

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Move to New section", () => {
  it("opens with an empty field the second time, after a section was added", async () => {
    const onAssign = vi.fn();
    const onClose = vi.fn();
    const render = (anchor: { x: number; y: number } | null) =>
      act(async () => root.render(createElement(SectionPicker, { current: undefined, anchor, onClose, onAssign })));
    await render({ x: 10, y: 10 });
    await act(async () => type(field(), "Research"));
    expect(field().value).toBe("Research");
    await act(async () => field().form!.requestSubmit());
    expect(onAssign).toHaveBeenCalledWith("Research");
    await render(null);
    await render({ x: 20, y: 20 });
    expect(field().value).toBe("");
  });

  it("drops a name typed and then left behind when the menu opens again", async () => {
    const render = (anchor: { x: number; y: number } | null) =>
      act(async () => root.render(createElement(SectionPicker, { current: undefined, anchor, onClose: vi.fn(), onAssign: vi.fn() })));
    await render({ x: 10, y: 10 });
    await act(async () => type(field(), "Half typed"));
    await render(null);
    await render({ x: 20, y: 20 });
    expect(field().value).toBe("");
  });
});
