// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountBridge, CloudAccountState } from "../../electron/cloud-account.mjs";
import type { CloudLendingBridge, CloudLendingSnapshot } from "../../electron/computer-sharing.mjs";
import { setLocale } from "@/lib/i18n";
import { CloudAccountSettings } from "./CloudAccountSettings";

const account = { id: "user-1", email: "jo@example.test" };
const beta = { plan: "pro" as const, tier: "beta", status: "active" as const, expiresAt: 1_900_000_000_000, version: 1 };
const ready: CloudAccountState = { status: "connected", account, entitlement: beta, machine: { status: "ready", origin: "https://h1-home.later.dog" } };

let host: HTMLDivElement;
let root: Root;
let push: (state: CloudAccountState) => void;
let bridge: CloudAccountBridge;
const onGetPhone = vi.fn();

function makeBridge(initial: CloudAccountState): CloudAccountBridge {
  return {
    state: vi.fn(async () => initial),
    begin: vi.fn(async () => ({ status: "connecting", enrollment: { userCode: "ABCDE-FGHJK", expiresAt: Date.UTC(2026, 9, 13, 22, 0) } }) as CloudAccountState),
    signInAgain: vi.fn(async () => ({ status: "connecting" }) as CloudAccountState),
    reopen: vi.fn(async () => ({ status: "connecting" }) as CloudAccountState),
    cancel: vi.fn(async () => ({ status: "signed-out" }) as CloudAccountState),
    refresh: vi.fn(async () => ready),
    signOut: vi.fn(async () => ({ status: "signed-out" }) as CloudAccountState),
    openDashboard: vi.fn(async () => ready),
    connectHome: vi.fn(async () => ready),
    connectHomeForPhone: vi.fn(async () => ready),
    onState: vi.fn((callback) => { push = callback; return () => {}; }),
  };
}

async function show(laterdog: Record<string, unknown>) {
  (window as unknown as { laterdog?: unknown }).laterdog = laterdog;
  await act(async () => { root.render(createElement(CloudAccountSettings, { onGetPhone })); });
  await act(async () => { await Promise.resolve(); });
}

const text = () => host.textContent ?? "";
const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
async function click(label: string) {
  const target = button(label);
  expect(target, `button ${label}`).toBeTruthy();
  await act(async () => { target!.click(); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  onGetPhone.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as { laterdog?: unknown }).laterdog;
  vi.unstubAllGlobals();
});

describe("Settings, later.dog Cloud on this Mac", () => {
  it("offers one Sign in, then shows the code the browser shows", async () => {
    bridge = makeBridge({ status: "signed-out" });
    await show({ cloudAccount: bridge });
    expect(host.querySelector("[data-cloud-account]")?.getAttribute("data-cloud-account")).toBe("signed-out");
    expect(text()).toContain("Not signed in");
    expect(text()).toContain("Sign in to use your dogs from your iPhone");
    await click("Sign in");
    expect(bridge.begin).toHaveBeenCalledOnce();
    expect(host.querySelector("[data-cloud-code]")?.textContent).toBe("ABCDE-FGHJK");
    expect(text()).toContain("Continue in your browser");
    await click("Cancel");
    expect(bridge.cancel).toHaveBeenCalledOnce();
    expect(button("Sign in")).toBeTruthy();
  });

  it("opens My Cloud by itself once, right after signing in here, when it is ready", async () => {
    bridge = makeBridge({ status: "signed-out" });
    await show({ cloudAccount: bridge });
    await click("Sign in");
    await act(async () => push({ ...ready, machine: { status: "provisioning", setup: { step: "starting" } } }));
    expect(bridge.connectHome).not.toHaveBeenCalled();
    await act(async () => push(ready));
    await act(async () => { await Promise.resolve(); });
    expect(bridge.connectHome).toHaveBeenCalledOnce();
    await act(async () => push({ ...ready, checking: true }));
    await act(async () => push(ready));
    expect(bridge.connectHome).toHaveBeenCalledOnce();
  });

  it("never opens My Cloud by itself for a sign-in that was already there", async () => {
    bridge = makeBridge(ready);
    await show({ cloudAccount: bridge });
    await act(async () => push(ready));
    expect(bridge.connectHome).not.toHaveBeenCalled();
  });

  it("shows the email and the beta, and opens My Cloud once it's ready", async () => {
    bridge = makeBridge(ready);
    await show({ cloudAccount: bridge });
    expect(text()).toContain("jo@example.test");
    expect(text()).toContain("free during the beta");
    expect(host.querySelector("[data-cloud-home]")?.getAttribute("data-cloud-home")).toBe("ready");
    await click("Open My Cloud");
    expect(bridge.connectHome).toHaveBeenCalledOnce();
    expect(bridge.connectHomeForPhone).not.toHaveBeenCalled();
  });

  it("says when My Cloud is still being set up, with nothing to open yet", async () => {
    bridge = makeBridge({ ...ready, machine: { status: "provisioning", setup: { step: "starting" } } });
    await show({ cloudAccount: bridge });
    expect(text()).toContain("Setting up My Cloud");
    expect(button("Open My Cloud")).toBeUndefined();
    await act(async () => push(ready));
    expect(button("Open My Cloud")).toBeTruthy();
  });

  it("keeps trying while My Cloud wakes up, saying so, and opens it when it answers", async () => {
    vi.useFakeTimers();
    try {
      bridge = makeBridge(ready);
      vi.mocked(bridge.connectHome).mockRejectedValueOnce(new Error("not ready")).mockRejectedValueOnce(new Error("not ready"));
      await show({ cloudAccount: bridge });
      await click("Open My Cloud");
      expect(host.querySelector("[data-cloud-home]")?.textContent).toBe("Waking up My Cloud…");
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(bridge.connectHome).toHaveBeenCalledTimes(3);
      expect(host.querySelector("[role=alert]")).toBeNull();
      expect(host.querySelector("[data-cloud-home]")?.getAttribute("data-cloud-home")).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says plainly when My Cloud still can't be opened after a minute of trying", async () => {
    vi.useFakeTimers();
    try {
      bridge = makeBridge(ready);
      vi.mocked(bridge.connectHome).mockRejectedValue(new Error("offline"));
      await show({ cloudAccount: bridge });
      await click("Open My Cloud");
      for (let step = 0; step < 5; step += 1) await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(bridge.connectHome).toHaveBeenCalledTimes(5);
      expect(host.querySelector("[role=alert]")?.textContent).toBe("Couldn't open My Cloud. Try again in a moment.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks before signing out, and says the dogs stay in My Cloud", async () => {
    bridge = makeBridge(ready);
    await show({ cloudAccount: bridge });
    await click("Sign out");
    expect(bridge.signOut).not.toHaveBeenCalled();
    expect(text()).toContain("Your dogs and chats stay in My Cloud");
    await click("Keep signed in");
    expect(host.querySelector("[data-cloud-signout-confirm]")).toBeNull();
    await click("Sign out");
    const confirm = host.querySelector("[data-cloud-signout-confirm]")!;
    await act(async () => { [...confirm.querySelectorAll("button")].find((candidate) => candidate.textContent === "Sign out")!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(bridge.signOut).toHaveBeenCalledOnce();
    expect(button("Sign in")).toBeTruthy();
  });

  it("asks to sign in again when the sign-in ended, and retries when Cloud is unreachable", async () => {
    bridge = makeBridge({ status: "reauth-required", account });
    await show({ cloudAccount: bridge });
    expect(text()).toContain("Sign in again to keep using My Cloud");
    await click("Sign in again");
    expect(bridge.signInAgain).toHaveBeenCalledOnce();
    await act(async () => push({ status: "unavailable", account }));
    expect(text()).toContain("can't be reached right now");
    await click("Try again");
    expect(bridge.refresh).toHaveBeenCalledOnce();
  });

  it("tells a person when the beta is full", async () => {
    bridge = makeBridge({ status: "connected", account, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } });
    await show({ cloudAccount: bridge });
    expect(text()).toContain("later.dog Cloud is full right now");
    expect(host.querySelector("[data-cloud-home]")).toBeNull();
  });

  it("lends this Mac from the same card once signed in", async () => {
    const snapshot: CloudLendingSnapshot = { available: true, screenAvailable: true, state: { enabled: false, folders: [], screen: false, busy: false } };
    const lending: CloudLendingBridge = {
      state: vi.fn(async () => snapshot),
      chooseFolder: vi.fn(async () => ({ id: "f1", name: "Downloads", path: "/Users/jo/Downloads", write: false })),
      save: vi.fn(async (input) => ({ ...snapshot, state: { enabled: true, folders: input.folders, screen: input.screen, busy: false, connected: true } })),
      stop: vi.fn(async () => snapshot),
    };
    bridge = { ...makeBridge(ready), lending };
    await show({ cloudAccount: bridge });
    expect(text()).toContain("Let My Cloud use this Mac");
    await act(async () => { host.querySelector<HTMLButtonElement>("[role=switch]")!.click(); });
    expect(text()).toContain("Pick a folder, or apps and screen.");
    await click("Add folder");
    expect(lending.save).toHaveBeenCalledWith({ folders: [{ id: "f1", name: "Downloads", path: "/Users/jo/Downloads", write: false }], screen: false });
    expect(host.querySelector("[data-lent-folder]")?.getAttribute("data-lent-folder")).toBe("Downloads");
    expect(text()).toContain("On. My Cloud can use this Mac while it's awake.");
  });

  it("opens the iPhone app panel", async () => {
    bridge = makeBridge({ status: "signed-out" });
    await show({ cloudAccount: bridge });
    await click("Get the app");
    expect(onGetPhone).toHaveBeenCalledOnce();
  });
});

describe("Settings, later.dog Cloud while the window shows My Cloud", () => {
  it("switches back to this Mac and opens lending there, without touching the sign-in", async () => {
    const cloudAccount = makeBridge(ready);
    const cloudPlan = { state: vi.fn(), manage: vi.fn(), useThisComputer: vi.fn(async () => {}) };
    const cloudLending = { open: vi.fn(async () => {}) };
    await show({ cloudAccount, cloudPlan, cloudLending, remoteClient: { active: true } });
    expect(cloudAccount.state).not.toHaveBeenCalled();
    expect(text()).toContain("You're on My Cloud");
    await click("Switch to this Mac");
    expect(cloudPlan.useThisComputer).toHaveBeenCalledOnce();
    await click("Choose");
    expect(cloudLending.open).toHaveBeenCalledOnce();
  });

  it("shows only the phone app in a plain browser", async () => {
    await show({});
    expect(host.querySelector("[data-cloud-account]")?.getAttribute("data-cloud-account")).toBe("elsewhere");
    expect(text()).toContain("later.dog for iPhone");
  });
});
