// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdaterState } from "@/lib/updater";

const fixture = vi.hoisted(() => ({ state: { status: "idle" } as UpdaterState }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => fixture.state }));

const { UpdatesRow } = await import("./SettingsModal");

function mount(state: UpdaterState) {
  fixture.state = state;
  const updater = { check: vi.fn(async () => {}), install: vi.fn(async () => {}), onState: vi.fn() };
  (window as unknown as { laterdog: unknown }).laterdog = { updater };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(createElement(UpdatesRow)));
  return { host, root, updater, button: () => host.querySelector("button")! };
}

afterEach(() => {
  document.body.innerHTML = "";
  delete (window as unknown as { laterdog?: unknown }).laterdog;
});

it("restarts with the version the row shows", () => {
  const { button, updater, root } = mount({ status: "downloaded", version: "0.3.43" });
  flushSync(() => button().click());
  expect(updater.install).toHaveBeenCalledWith("0.3.43");
  root.unmount();
});

it("says after a restart whether the update worked, and offers to check again", () => {
  const updated = mount({ status: "idle", receipt: { outcome: "updated", version: "0.3.43" } });
  expect(updated.host.textContent).toContain("Updated to 0.3.43");
  updated.root.unmount();
  const unfinished = mount({ status: "idle", receipt: { outcome: "unfinished", version: "0.3.43" } });
  expect(unfinished.host.textContent).toContain("The update to 0.3.43 didn't finish");
  flushSync(() => unfinished.button().click());
  expect(unfinished.updater.check).toHaveBeenCalled();
  unfinished.root.unmount();
});
