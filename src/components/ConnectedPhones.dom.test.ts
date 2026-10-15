// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectedPhones } from "./PairedPhones";
import type { PhoneDeviceState } from "@/lib/phone-devices";

let root: Root;
let host: HTMLDivElement;
const devices = [{ id: "phone-1", name: "My iPhone", createdAt: 1, lastSeenAt: Date.now(), cloudDesktopAccess: false }];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as { laterdog?: unknown }).laterdog;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("revokes a connected phone without starting a pairing flow, ignoring an older refresh", async () => {
  let resolveRefresh!: (state: PhoneDeviceState) => void;
  const refresh = new Promise<PhoneDeviceState>((resolve) => { resolveRefresh = resolve; });
  const companion = {
    state: vi.fn().mockResolvedValueOnce({ devices }).mockReturnValueOnce(refresh),
    revoke: vi.fn(async () => ({ devices: [] })),
    start: vi.fn(), pairing: vi.fn(),
  };
  (window as unknown as { laterdog?: unknown }).laterdog = { companion };
  await act(async () => { root.render(createElement(ConnectedPhones)); });
  expect(host.textContent).toContain("My iPhone");
  await act(async () => { vi.advanceTimersByTime(5_000); });
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-paired-phone-remove="phone-1"]')!.click(); });
  expect(companion.revoke).toHaveBeenCalledExactlyOnceWith("phone-1");
  expect(host.textContent).not.toContain("My iPhone");
  await act(async () => { resolveRefresh({ devices }); });
  expect(host.textContent).not.toContain("My iPhone");
  expect(companion.start).not.toHaveBeenCalled();
  expect(companion.pairing).not.toHaveBeenCalled();
});


it("clears an earlier refresh failure when connected devices load again", async () => {
  const companion = {
    state: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ devices }),
  };
  (window as unknown as { laterdog?: unknown }).laterdog = { companion };
  await act(async () => { root.render(createElement(ConnectedPhones)); });
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => { vi.advanceTimersByTime(5_000); });
  expect(host.textContent).toContain("My iPhone");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("resets a replaced bridge while preserving its own pending device change", async () => {
  let resolveOld!: (state: PhoneDeviceState) => void;
  let resolveNew!: (state: PhoneDeviceState) => void;
  const oldRemoval = new Promise<PhoneDeviceState>((resolve) => { resolveOld = resolve; });
  const newRemoval = new Promise<PhoneDeviceState>((resolve) => { resolveNew = resolve; });
  const nextDevices = [{ ...devices[0]!, id: "phone-2", name: "Other iPhone" }];
  const oldBridge = {
    state: vi.fn().mockResolvedValue({ devices }),
    revoke: vi.fn().mockReturnValue(oldRemoval),
  };
  const newBridge = {
    state: vi.fn().mockResolvedValue({ devices: nextDevices }),
    revoke: vi.fn().mockReturnValue(newRemoval),
  };
  (window as unknown as { laterdog?: unknown }).laterdog = { companion: oldBridge };
  await act(async () => { root.render(createElement(ConnectedPhones)); });
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-paired-phone-remove="phone-1"]')!.click(); });
  expect(host.querySelector<HTMLButtonElement>('[data-paired-phone-remove="phone-1"]')!.disabled).toBe(true);
  (window as unknown as { laterdog?: unknown }).laterdog = { companion: newBridge };
  await act(async () => { root.render(createElement(ConnectedPhones)); });
  const removeNew = host.querySelector<HTMLButtonElement>('[data-paired-phone-remove="phone-2"]')!;
  expect(removeNew.disabled).toBe(false);
  await act(async () => { removeNew.click(); });
  expect(newBridge.revoke).toHaveBeenCalledExactlyOnceWith("phone-2");
  await act(async () => { resolveOld({ devices: [] }); });
  expect(host.textContent).toContain("Other iPhone");
  expect(removeNew.disabled).toBe(true);
  await act(async () => { vi.advanceTimersByTime(5_000); });
  expect(newBridge.state).toHaveBeenCalledTimes(1);
  await act(async () => { resolveNew({ devices: [] }); });
  expect(host.textContent).not.toContain("Other iPhone");
});
