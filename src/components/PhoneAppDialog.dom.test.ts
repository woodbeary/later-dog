// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountBridge, CloudAccountState } from "../../electron/cloud-account.mjs";
import { setLocale } from "@/lib/i18n";
import { PhoneAppDialog } from "./PhoneAppDialog";

const fixture = vi.hoisted(() => ({ openExternalLink: vi.fn(async () => {}) }));
vi.mock("@/lib/app-links", () => ({ openExternalLink: fixture.openExternalLink }));

let host: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

function bridgeWith(initial: CloudAccountState): CloudAccountBridge {
  return {
    state: vi.fn(async () => initial), begin: vi.fn(async () => ({ status: "connecting" }) as CloudAccountState),
    signInAgain: vi.fn(), reopen: vi.fn(), cancel: vi.fn(), refresh: vi.fn(), signOut: vi.fn(), openDashboard: vi.fn(),
    connectHome: vi.fn(), connectHomeForPhone: vi.fn(), onState: vi.fn(() => () => {}),
  } as unknown as CloudAccountBridge;
}

async function show(laterdog?: Record<string, unknown>) {
  (window as unknown as { laterdog?: unknown }).laterdog = laterdog;
  await act(async () => { root.render(createElement(PhoneAppDialog, { open: true, onClose })); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
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
});

describe("Get later.dog for iPhone", () => {
  it("shows a code to scan and the link, with the email to sign in with", async () => {
    await show({ cloudAccount: bridgeWith({ status: "connected", account: { id: "u", email: "jo@example.test" } }) });
    expect(host.querySelector("[data-phone-app-qr]")?.getAttribute("data-phone-app-qr")).toBe("https://accounts.later.dog/iphone");
    expect(host.querySelector("svg")).toBeTruthy();
    expect(host.textContent).toContain("Then sign in with jo@example.test.");
    const link = [...host.querySelectorAll("button")].find((button) => button.textContent === "Or open the link")!;
    await act(async () => { link.click(); });
    expect(fixture.openExternalLink).toHaveBeenCalledWith("https://accounts.later.dog/iphone");
  });

  it("offers Cloud sign-in on this Mac when it isn't signed in", async () => {
    const cloudAccount = bridgeWith({ status: "signed-out" });
    await show({ cloudAccount });
    const signIn = [...host.querySelectorAll("button")].find((button) => button.textContent === "Sign in to later.dog Cloud")!;
    await act(async () => { signIn.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(cloudAccount.begin).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Continue in your browser");
  });

  it("closes with Escape or the close button", async () => {
    await show();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => { host.querySelector<HTMLButtonElement>("[aria-label=Close]")!.click(); });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
