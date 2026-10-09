// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhoneDevice, PhoneSetupController } from "./PhoneSetupFlow";

const fixture = vi.hoisted(() => ({
  calls: [] as unknown[][],
  controller: null as unknown as PhoneSetupController,
}));
vi.mock("./PhoneSetupFlow", () => ({
  usePhoneSetupController: () => fixture.controller,
  PhoneSetupFlowView: () => null,
}));
vi.mock("./ServerPairingCard", () => ({
  ServerPairingCard: ({ cloudHome }: { cloudHome: boolean }) => createElement("div", { "data-server-pairing-card": cloudHome ? "cloud" : "server" }),
}));

const { PairedPhones, lastSeenAgo } = await import("./PairedPhones");
const { PhonePairingDialog } = await import("./PhonePairingDialog");

const NOW = Date.UTC(2026, 9, 9, 12);
const phone = (patch: Partial<PhoneDevice> = {}): PhoneDevice => ({
  id: "phone-1", name: "Jacob's iPhone", createdAt: NOW - 86_400_000, lastSeenAt: NOW - 5 * 60_000, cloudDesktopAccess: false, ...patch,
});
const controller = (devices: PhoneDevice[], patch: Partial<PhoneSetupController> = {}) => ({
  state: { devices },
  phase: "intro",
  busy: false,
  act: async (call: (companion: Record<string, (...args: unknown[]) => unknown>) => unknown) => {
    await call(new Proxy({}, { get: (_target, name) => (...args: unknown[]) => fixture.calls.push([name, ...args]) }));
  },
  ...patch,
}) as unknown as PhoneSetupController;

let root: Root | null = null;
const render = (element: ReturnType<typeof createElement>) => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(element));
};
const text = () => document.body.textContent ?? "";
const switchFor = (label: string) => document.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!;

beforeEach(() => {
  fixture.calls = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("when a phone was last seen", () => {
  it("reads in a word or two", () => {
    expect(lastSeenAgo(NOW - 30_000, NOW)).toBe("just now");
    expect(lastSeenAgo(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(lastSeenAgo(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    expect(lastSeenAgo(NOW - 2 * 86_400_000, NOW)).toBe("2 d ago");
  });
});

describe("Paired devices", () => {
  it("shows nothing until a phone is paired", () => {
    render(createElement(PairedPhones, { controller: controller([]) }));
    expect(document.querySelector("[data-paired-phones]")).toBeNull();
  });

  it("lists each phone with when it was last seen and what it may do", () => {
    render(createElement(PairedPhones, { controller: controller([phone(), phone({ id: "phone-2", name: "iPad", cloudDesktopAccess: true, browserControlAccess: true })]) }));
    expect(text()).toContain("Paired devices");
    expect(text()).toContain("Jacob's iPhoneLast seen 5 min ago");
    expect(switchFor("Computer view access for Jacob's iPhone").getAttribute("aria-checked")).toBe("false");
    expect(switchFor("Browser control access for Jacob's iPhone").getAttribute("aria-checked")).toBe("false");
    expect(switchFor("Computer view access for iPad").getAttribute("aria-checked")).toBe("true");
    expect(switchFor("Browser control access for iPad").getAttribute("aria-checked")).toBe("true");
  });

  it("removes a phone and flips its access through the companion", async () => {
    render(createElement(PairedPhones, { controller: controller([phone({ cloudDesktopAccess: true })]) }));
    flushSync(() => document.querySelector<HTMLButtonElement>('[data-paired-phone-remove="phone-1"]')!.click());
    flushSync(() => switchFor("Computer view access for Jacob's iPhone").click());
    flushSync(() => switchFor("Browser control access for Jacob's iPhone").click());
    await Promise.resolve();
    expect(fixture.calls).toEqual([
      ["revoke", "phone-1"],
      ["cloudDesktop", "phone-1", false],
      ["browserControl", "phone-1", true],
    ]);
  });

  it("holds every control while the companion is busy", () => {
    render(createElement(PairedPhones, { controller: controller([phone()], { busy: true }) }));
    const controls = [...document.querySelectorAll<HTMLButtonElement>("[data-paired-phones] button")];
    expect(controls).toHaveLength(3);
    expect(controls.every((control) => control.disabled)).toBe(true);
  });
});

describe("Connect your phone", () => {
  it("shows the paired phones below the flow's first step, and not while pairing", () => {
    fixture.controller = controller([phone()]);
    render(createElement(PhonePairingDialog, { open: true, onClose: () => {} }));
    expect(document.querySelector('[data-paired-phone="phone-1"]')).not.toBeNull();
    root!.unmount();
    document.body.innerHTML = "";

    fixture.controller = controller([phone()], { phase: "qr" });
    render(createElement(PhonePairingDialog, { open: true, onClose: () => {} }));
    expect(document.querySelector("[data-phone-pairing-dialog]")).not.toBeNull();
    expect(document.querySelector("[data-paired-phones]")).toBeNull();
  });

  it("on a Cloud or another server, shows that server's pairing code instead of this computer's phones", () => {
    fixture.controller = controller([phone()]);
    for (const target of ["cloud", "server"] as const) {
      render(createElement(PhonePairingDialog, { open: true, onClose: () => {}, target }));
      expect(document.querySelector(`[data-server-pairing-card="${target}"]`)).not.toBeNull();
      expect(document.querySelector("[data-paired-phones]")).toBeNull();
      root!.unmount();
      document.body.innerHTML = "";
    }
  });

  it("renders nothing while closed", () => {
    fixture.controller = controller([phone()]);
    render(createElement(PhonePairingDialog, { open: false, onClose: () => {} }));
    expect(document.querySelector("[data-phone-pairing-dialog]")).toBeNull();
  });
});
