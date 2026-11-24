// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), api: fixture.api }));

import { FullAccessAllGroup, type FullAccessAllView } from "./FullAccessAllGroup";

let host: HTMLDivElement;
let root: Root;

async function show(view: FullAccessAllView) {
  fixture.api.mockImplementation(async (_path: string, init?: { method?: string; body?: string }) => {
    if (init?.method !== "PUT") return view;
    return { ...view, enabled: JSON.parse(init.body ?? "{}").enabled as boolean };
  });
  await act(async () => root.render(createElement(FullAccessAllGroup)));
}

const toggle = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  fixture.api.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Full access for all my dogs in Settings", () => {
  it("shows one switch, off by default", async () => {
    await show({ enabled: false, dogs: 5, full: 0 });
    expect(host.textContent).toContain("Full access for all my dogs");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(host.querySelectorAll('[role="switch"]').length).toBe(1);
  });

  it("turns it on, saves it, and says how many dogs are on Full access", async () => {
    await show({ enabled: false, dogs: 5, full: 0 });
    await act(async () => toggle().click());
    expect(fixture.api).toHaveBeenLastCalledWith("/api/full-access-all", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector('[data-full-access-all="on"]')).not.toBeNull();
  });

  it("says so when the save fails and keeps the switch where it was, and shows nothing before the home answers", async () => {
    await show({ enabled: true, dogs: 5, full: 3 });
    expect(host.textContent).toContain("3 of 5");
    fixture.api.mockRejectedValueOnce(new Error("offline"));
    await act(async () => toggle().click());
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("Couldn't save. Try again.");
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    await act(async () => root.unmount());
    root = createRoot(host);
    fixture.api.mockRejectedValue(new Error("offline"));
    await act(async () => root.render(createElement(FullAccessAllGroup)));
    expect(host.textContent).toBe("");
  });
});
