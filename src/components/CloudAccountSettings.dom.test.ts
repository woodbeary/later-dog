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
    sendCode: vi.fn(async (email: string) => ({ ok: true as const, email })),
    verifyCode: vi.fn(async () => ({ ok: true as const, account: ready })),
    offer: vi.fn(async () => ({ due: false })),
    declineOffer: vi.fn(async () => ({ due: false })),
    onState: vi.fn((callback) => { push = callback; return () => {}; }),
  };
}

async function show(laterdog: Record<string, unknown>, onOpenComputer?: () => void) {
  (window as unknown as { laterdog?: unknown }).laterdog = laterdog;
  await act(async () => { root.render(createElement(CloudAccountSettings, { onOpenComputer })); });
  await act(async () => { await Promise.resolve(); });
}

const text = () => host.textContent ?? "";
const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
async function type(selector: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(selector);
  expect(input, `input ${selector}`).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
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
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as { laterdog?: unknown }).laterdog;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Settings, later.dog Cloud on this Mac", () => {
  it("asks for an email, sends a code, and signs in with the 8 digits without a browser or a second tap", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 14));
    bridge = makeBridge({ status: "signed-out" });
    await show({ cloudAccount: bridge });
    expect(host.querySelector("[data-cloud-account]")?.getAttribute("data-cloud-account")).toBe("signed-out");
    expect(text()).toContain("Not signed in");
    expect(button("Agree and continue")?.disabled).toBe(true);
    await type("input[type=email]", "jo@example.test");
    await click("Agree and continue");
    expect(bridge.sendCode).toHaveBeenCalledWith("jo@example.test");
    expect(host.querySelector("[data-cloud-sign-in]")?.getAttribute("data-cloud-sign-in")).toBe("code");
    expect(text()).toContain("jo@example.test");
    await type("input[autocomplete=one-time-code]", "1234567");
    expect(bridge.verifyCode).not.toHaveBeenCalled();
    await type("input[autocomplete=one-time-code]", "1234 5678");
    expect(bridge.verifyCode).toHaveBeenCalledWith("jo@example.test", "12345678");
    expect(bridge.begin).not.toHaveBeenCalled();
  });

  it("says it is sending the code and accepts only one request while it waits", async () => {
    bridge = makeBridge({ status: "signed-out" });
    let finish!: (result: Awaited<ReturnType<CloudAccountBridge["sendCode"]>>) => void;
    vi.mocked(bridge.sendCode).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await show({ cloudAccount: bridge });
    await type("input[type=email]", "jo@example.test");
    await click("Agree and continue");
    expect(button("Sending code…")?.disabled).toBe(true);
    expect(host.querySelector("[role=status]")?.textContent).toBe("Sending code…");
    const emailInput = host.querySelector<HTMLInputElement>("input[type=email]")!;
    expect(emailInput.disabled).toBe(true);
    await click("Sending code…");
    await act(async () => { emailInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(bridge.sendCode).toHaveBeenCalledOnce();
    await act(async () => { finish({ ok: true, email: "jo@example.test" }); });
    expect(host.querySelector("[data-cloud-sign-in]")?.getAttribute("data-cloud-sign-in")).toBe("code");
  });

  it.each(["backend", "unavailable", "bridge"] as const)("shows a %s send failure and permits an immediate retry", async (failure) => {
    bridge = makeBridge({ status: "signed-out" });
    if (failure === "backend") vi.mocked(bridge.sendCode).mockResolvedValueOnce({ ok: false, code: "email_unavailable" });
    else if (failure === "unavailable") vi.mocked(bridge.sendCode).mockResolvedValueOnce({ ok: false, code: "unavailable" });
    else vi.mocked(bridge.sendCode).mockRejectedValueOnce(new Error("disconnected"));
    await show({ cloudAccount: bridge });
    await type("input[type=email]", "jo@example.test");
    await click("Agree and continue");
    expect(host.querySelector("[role=alert]")?.textContent).toBe(failure === "backend"
      ? "later.dog can't send sign-in emails right now. Try again in a little while."
      : "Couldn't send a code. Try again.");
    expect(button("Agree and continue")?.disabled).toBe(false);
    expect(host.querySelector<HTMLInputElement>("input[type=email]")?.disabled).toBe(false);
    await click("Agree and continue");
    expect(bridge.sendCode).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[role=alert]")).toBeNull();
    expect(host.querySelector("[data-cloud-sign-in]")?.getAttribute("data-cloud-sign-in")).toBe("code");
  });

  it.each(["backend", "bridge"] as const)("keeps code verification advice for a %s failure after a code was sent", async (failure) => {
    bridge = makeBridge({ status: "signed-out" });
    if (failure === "backend") vi.mocked(bridge.verifyCode).mockResolvedValueOnce({ ok: false, code: "unavailable" });
    else vi.mocked(bridge.verifyCode).mockRejectedValueOnce(new Error("disconnected"));
    await show({ cloudAccount: bridge });
    await type("input[type=email]", "jo@example.test");
    await click("Agree and continue");
    await type("input[autocomplete=one-time-code]", "12345678");
    expect(host.querySelector("[role=alert]")?.textContent).toBe("That didn't work. Try again, or send a new code.");
    expect(host.querySelector<HTMLInputElement>("input[autocomplete=one-time-code]")?.disabled).toBe(false);
  });

  it("says a replacement code could not be sent and keeps code entry available", async () => {
    vi.useFakeTimers();
    try {
      bridge = makeBridge({ status: "signed-out" });
      await show({ cloudAccount: bridge });
      await type("input[type=email]", "jo@example.test");
      await click("Agree and continue");
      for (let second = 0; second < 30; second += 1) await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      vi.mocked(bridge.sendCode).mockResolvedValueOnce({ ok: false, code: "unavailable" });
      await click("Resend code");
      expect(host.querySelector("[role=alert]")?.textContent).toBe("Couldn't send a code. Try again.");
      expect(host.querySelector<HTMLInputElement>("input[autocomplete=one-time-code]")?.disabled).toBe(false);
      expect(button("Resend code")?.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the current email while a code is being checked", async () => {
    bridge = makeBridge({ status: "signed-out" });
    let finish!: (result: Awaited<ReturnType<CloudAccountBridge["verifyCode"]>>) => void;
    vi.mocked(bridge.verifyCode).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await show({ cloudAccount: bridge });
    await type("input[type=email]", "jo@example.test");
    await click("Agree and continue");
    await type("input[autocomplete=one-time-code]", "00000000");
    expect(button("Use a different email")?.disabled).toBe(true);
    await click("Use a different email");
    expect(host.querySelector("[data-cloud-sign-in]")?.getAttribute("data-cloud-sign-in")).toBe("code");
    await act(async () => { finish({ ok: false, code: "wrong_code" }); });
    expect(button("Use a different email")?.disabled).toBe(false);
    await click("Use a different email");
    expect(host.querySelector<HTMLInputElement>("input[type=email]")?.value).toBe("jo@example.test");
  });

  it("says why a code failed and lets the person try again, and a different email", async () => {
    bridge = makeBridge({ status: "signed-out" });
    vi.mocked(bridge.verifyCode).mockResolvedValueOnce({ ok: false, code: "wrong_code" });
    await show({ cloudAccount: bridge });
    await type("input[type=email]", "jo@example.test");
    await click("Agree and continue");
    await type("input[autocomplete=one-time-code]", "00000000");
    expect(host.querySelector("[data-cloud-sign-in-problem]")?.textContent).toBe("That code didn't match. Check the email and try again.");
    expect((host.querySelector("input[autocomplete=one-time-code]") as HTMLInputElement).value).toBe("");
    await click("Use a different email");
    expect(host.querySelector("[data-cloud-sign-in]")?.getAttribute("data-cloud-sign-in")).toBe("email");
  });

  it("shows the terms line the phone shows, with working links", async () => {
    bridge = makeBridge({ status: "signed-out" });
    await show({ cloudAccount: bridge });
    expect(host.querySelector("[data-cloud-sign-in-agreement]")?.textContent).toBe("You accept the Terms and Privacy Policy, and that what you send your dogs goes to the AI that answers them, like Kimi on Cloudflare or Grok by xAI.");
    expect([...host.querySelectorAll("[data-cloud-sign-in-agreement] a")].map((link) => (link as HTMLAnchorElement).href)).toEqual(["https://accounts.later.dog/terms", "https://accounts.later.dog/privacy"]);
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
    expect(button("Agree and continue")).toBeTruthy();
  });

  it("asks to sign in again when the sign-in ended, and retries when Cloud is unreachable", async () => {
    bridge = makeBridge({ status: "reauth-required", account });
    await show({ cloudAccount: bridge });
    expect(text()).toContain("Sign in again to keep using My Cloud");
    expect(host.querySelector("[data-cloud-sign-in]")).toBeTruthy();
    expect(button("Sign in again")).toBeUndefined();
    expect(bridge.signInAgain).not.toHaveBeenCalled();
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

  it("connects this Mac by itself once signed in, with one switch to turn it off", async () => {
    let snapshot: CloudLendingSnapshot = { available: true, screenAvailable: false, state: { on: true, name: "Jo's MacBook Air", enabled: true, busy: false, connected: true }, activity: [] };
    const lending: CloudLendingBridge = {
      state: vi.fn(async () => snapshot),
      setHome: vi.fn(async (on) => {
        snapshot = { ...snapshot, state: { on, name: "Jo's MacBook Air", enabled: on, busy: false, connected: on } };
        return snapshot;
      }),
    };
    const onOpenComputer = vi.fn();
    bridge = { ...makeBridge(ready), lending };
    await show({ cloudAccount: bridge }, onOpenComputer);
    expect(text()).toContain("Let My Cloud use this Mac");
    expect(text()).toContain("On. My Cloud can use Jo's MacBook Air when you ask.");
    expect(host.querySelector("[role=switch]")?.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector("[data-lent-folder]")).toBeNull();
    expect(text()).toContain("To use apps on this Mac too, allow later.dog in Computer settings.");
    await click("Open");
    expect(onOpenComputer).toHaveBeenCalledOnce();
    await act(async () => { host.querySelector<HTMLButtonElement>("[role=switch]")!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(lending.setHome).toHaveBeenCalledWith(false);
    expect(host.querySelector("[role=switch]")?.getAttribute("aria-checked")).toBe("false");
    expect(text()).toContain("Off. My Cloud can't use this Mac.");
    expect(host.querySelector("[data-lending-apps-off]")).toBeNull();
  });

  it("says when My Cloud is using this Mac", async () => {
    const lending: CloudLendingBridge = {
      state: vi.fn(async () => ({ available: true, screenAvailable: true, state: { on: true, enabled: true, busy: true, connected: true }, activity: [] })),
      setHome: vi.fn(),
    };
    bridge = { ...makeBridge(ready), lending };
    await show({ cloudAccount: bridge });
    expect(text()).toContain("My Cloud is using this Mac now.");
    expect(host.querySelector("[data-lending-apps-off]")).toBeNull();
  });
});

describe("Settings, later.dog Cloud while the window shows My Cloud", () => {
  it("offers no server switching, asks before signing out, and opens lending, without touching the sign-in", async () => {
    const cloudPlan = { state: vi.fn(), manage: vi.fn(), signOut: vi.fn(async () => {}) };
    const cloudLending = { open: vi.fn(async () => {}) };
    await show({ cloudPlan, cloudLending });
    expect(text()).toContain("You're on My Cloud");
    expect(text()).not.toContain("Switch to this Mac");
    await click("Manage");
    expect(cloudLending.open).toHaveBeenCalledOnce();
    await click("Sign out");
    expect(cloudPlan.signOut).not.toHaveBeenCalled();
    expect(text()).toContain("Your dogs and chats stay in My Cloud");
    await click("Keep signed in");
    expect(host.querySelector("[data-cloud-signout-confirm]")).toBeNull();
    await click("Sign out");
    await click("Sign out");
    expect(cloudPlan.signOut).toHaveBeenCalledOnce();
  });

  it("shows nothing in a plain browser", async () => {
    await show({});
    expect(host.querySelector("[data-cloud-account]")).toBeNull();
  });
});
