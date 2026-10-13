// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  config: { features: {} } as Record<string, unknown>,
  dispatch: vi.fn(),
  api: vi.fn(),
}));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));

const { StepUpdatesRow } = await import("./SettingsModal");

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(createElement(StepUpdatesRow)));
  return { host, root, toggle: () => host.querySelector<HTMLButtonElement>('[role="switch"]')! };
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("Step-by-step updates", () => {
  it("saves the switch and hands the new settings to the app", async () => {
    const saved = { features: { stepUpdates: true } };
    fixture.api.mockResolvedValueOnce(saved);
    const { root, toggle } = mount();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    flushSync(() => toggle().click());
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: saved }));
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PATCH", body: JSON.stringify({ features: { stepUpdates: true } }) });
    root.unmount();
  });

  it("says so when the save fails and leaves the setting alone", async () => {
    fixture.api.mockRejectedValueOnce(new Error("offline"));
    const { host, root, toggle } = mount();
    flushSync(() => toggle().click());
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not save. Try again."));
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(toggle().disabled).toBe(false);
    root.unmount();
  });
});
