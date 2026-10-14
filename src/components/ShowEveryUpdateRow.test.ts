// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(),
  useStore: () => ({ state: { config: { features: {} } }, dispatch: vi.fn() }),
}));

const { ShowEveryUpdateRow } = await import("./SettingsModal");
const { SHOW_EVERY_UPDATE_KEY, setShowEveryUpdate } = await import("@/lib/show-every-update");

afterEach(() => {
  setShowEveryUpdate(false);
  document.body.innerHTML = "";
});

describe("Show every update", () => {
  it("is a switch, off by default, that saves on this Mac when flipped", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(createElement(ShowEveryUpdateRow)));
    const toggle = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(host.textContent).toContain("Show every update");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    flushSync(() => toggle().click());
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem(SHOW_EVERY_UPDATE_KEY)).toBe("1");
    flushSync(() => toggle().click());
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    root.unmount();
  });
});
