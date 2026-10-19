// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), api: fixture.api }));

import { MacAccessGroup, type MacAccessView } from "./MacAccessGroup";

const air = { id: "mac-air", name: "Jo's MacBook Air", online: true, mode: "always" as const };
let host: HTMLDivElement;
let root: Root;

async function show(view: MacAccessView) {
  fixture.api.mockImplementation(async (_path: string, init?: { method?: string; body?: string }) => {
    if (init?.method !== "PUT") return view;
    const computers = JSON.parse(init.body ?? "{}").computers as Record<string, MacAccessView["mode"]>;
    return { ...view, macs: view.macs.map((mac) => ({ ...mac, mode: computers[mac.id] ?? mac.mode })) };
  });
  await act(async () => root.render(createElement(MacAccessGroup)));
}

const choice = (mode: string) => host.querySelector<HTMLButtonElement>(`[data-mac-choice="${mode}"]`)!;

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

describe("Your Macs in Settings", () => {
  it("shows each connected Mac with Always allow, Ask every time and Never, on Always allow by default", async () => {
    await show({ mode: "always", macs: [air] });
    expect(host.textContent).toContain("Your Macs");
    expect(host.textContent).toContain("Jo's MacBook Air");
    expect([...host.querySelectorAll("[data-mac-choice]")].map((button) => button.textContent)).toEqual(["Always allow", "Ask every time", "Never"]);
    expect(choice("always").getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector('[role="radiogroup"]')!.getAttribute("aria-label")).toBe("Dogs using Jo's MacBook Air");
  });

  it("saves one Mac's choice and shows what the home saved", async () => {
    await show({ mode: "always", macs: [air, { id: "mac-studio", name: "Studio", online: false, mode: "always" }] });
    await act(async () => choice("ask").click());
    expect(fixture.api).toHaveBeenLastCalledWith("/api/mac-access", { method: "PUT", body: JSON.stringify({ computers: { "mac-air": "ask" } }) });
    expect(host.querySelector('[data-mac-access="ask"]')).not.toBeNull();
    expect(host.textContent).toContain("Not connected right now.");
  });

  it("says so in that row when the save fails, and shows nothing without a Mac", async () => {
    await show({ mode: "always", macs: [air] });
    fixture.api.mockRejectedValueOnce(new Error("offline"));
    await act(async () => choice("never").click());
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("Couldn't save. Try again.");
    expect(choice("always").getAttribute("aria-checked")).toBe("true");
    await act(async () => root.unmount());
    root = createRoot(host);
    await show({ mode: "always", macs: [] });
    expect(host.textContent).toBe("");
  });
});
