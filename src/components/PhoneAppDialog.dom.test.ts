// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountBridge, CloudAccountState } from "../../electron/cloud-account.mjs";
import { setLocale } from "@/lib/i18n";
import { PhoneAppDialog } from "./PhoneAppDialog";
import { PhoneSetupFlow } from "./PhoneSetupFlow";

const fixture = vi.hoisted(() => ({ openExternalLink: vi.fn(async () => {}) }));
vi.mock("@/lib/app-links", () => ({ openExternalLink: fixture.openExternalLink }));

let host: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

function bridgeWith(initial: CloudAccountState): CloudAccountBridge {
  return {
    state: vi.fn(async () => initial), begin: vi.fn(), sendCode: vi.fn(), verifyCode: vi.fn(),
    signInAgain: vi.fn(), reopen: vi.fn(), cancel: vi.fn(), refresh: vi.fn(), signOut: vi.fn(), openDashboard: vi.fn(),
    connectHome: vi.fn(), connectHomeForPhone: vi.fn(), onState: vi.fn(() => () => {}),
  } as unknown as CloudAccountBridge;
}

async function show(laterdog?: Record<string, unknown>) {
  (window as unknown as { laterdog?: unknown }).laterdog = laterdog;
  await act(async () => { root.render(createElement(PhoneAppDialog, { open: true, onClose })); });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  onClose.mockReset();
  fixture.openExternalLink.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as { laterdog?: unknown }).laterdog;
  vi.unstubAllGlobals();
});

describe("Get later.dog for iPhone", () => {
  it("opens the download link and directs the phone to the exact signed-in account without a QR", async () => {
    const companion = { state: vi.fn(async () => ({ devices: [] })), start: vi.fn(), pairing: vi.fn() };
    await show({ cloudAccount: bridgeWith({ status: "connected", account: { id: "u", email: "jo@example.test" } }), companion });
    expect(host.textContent).toContain("Sign in on your iPhone with jo@example.test");
    expect(host.textContent).toContain("Keep your Mac awake.");
    expect(host.querySelector("[data-phone-app-qr], [data-phone-app-pair], [data-phone-pairing-dialog], [data-phone-pairing-action]")).toBeNull();
    expect(host.textContent).not.toMatch(/scan|Pair a device|Wi-Fi|pairing code/i);
    expect(companion.start).not.toHaveBeenCalled();
    expect(companion.pairing).not.toHaveBeenCalled();
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-phone-app-download]")!.click(); });
    expect(fixture.openExternalLink).toHaveBeenCalledWith("https://accounts.later.dog/iphone");
  });

  it("uses the existing account email sign-in form on a signed-out Mac", async () => {
    const cloudAccount = bridgeWith({ status: "signed-out" });
    await show({ cloudAccount });
    expect(host.querySelector('[data-cloud-sign-in="email"] input[type="email"]')).not.toBeNull();
    expect(host.textContent).toContain("use the same account in the iPhone app");
    expect(cloudAccount.begin).not.toHaveBeenCalled();
    expect(host.querySelector("[data-phone-app-pair], [data-phone-app-qr]")).toBeNull();
  });

  it("never reads or pairs a local companion from a remote workspace", async () => {
    const companion = { state: vi.fn(), start: vi.fn(), pairing: vi.fn() };
    await show({ companion, remoteClient: { active: true } });
    expect(companion.state).not.toHaveBeenCalled();
    expect(companion.start).not.toHaveBeenCalled();
    expect(companion.pairing).not.toHaveBeenCalled();
    expect(host.textContent).toContain("same account");
  });

  it("keeps onboarding account-only and lets a signed-in account continue", async () => {
    const onComplete = vi.fn();
    (window as unknown as { laterdog?: unknown }).laterdog = { cloudAccount: bridgeWith({ status: "connected", account: { id: "u", email: "jo@example.test" } }) };
    await act(async () => { root.render(createElement(PhoneSetupFlow, { variant: "onboarding", compactHeader: true, onComplete })); });
    expect(host.textContent).toContain("jo@example.test");
    expect(host.textContent).not.toMatch(/scan|pair|Wi-Fi/i);
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Continue")!.click(); });
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("closes with Escape or the close button", async () => {
    await show();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => { host.querySelector<HTMLButtonElement>("[aria-label=Close]")!.click(); });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
