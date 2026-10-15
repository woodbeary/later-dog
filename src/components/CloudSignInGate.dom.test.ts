// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountBridge, CloudAccountState } from "../../electron/cloud-account.mjs";
import { setLocale } from "@/lib/i18n";
import { CloudSignInGate, useCloudSignInGate } from "./CloudSignInGate";

const account = { id: "user-1", email: "jo@example.test" };
const beta = { plan: "pro" as const, tier: "beta", status: "active" as const, expiresAt: 1_900_000_000_000, version: 1 };
const ready: CloudAccountState = { status: "connected", account, entitlement: beta, machine: { status: "ready", origin: "https://h1-home.later.dog" } };

let host: HTMLDivElement;
let root: Root;
let push: (state: CloudAccountState) => void;

function makeBridge(initial: CloudAccountState, due = true): CloudAccountBridge {
  return {
    state: vi.fn(async () => initial),
    begin: vi.fn(), signInAgain: vi.fn(), reopen: vi.fn(), cancel: vi.fn(), refresh: vi.fn(), signOut: vi.fn(), openDashboard: vi.fn(), connectHome: vi.fn(), connectHomeForPhone: vi.fn(),
    sendCode: vi.fn(async (email: string) => ({ ok: true as const, email })),
    verifyCode: vi.fn(async () => ({ ok: true as const, account: ready })),
    offer: vi.fn(async () => ({ due })),
    declineOffer: vi.fn(async () => ({ due: false })),
    onState: vi.fn((callback) => { push = callback; return () => {}; }),
  } as unknown as CloudAccountBridge;
}

function Harness() {
  const gate = useCloudSignInGate();
  return createElement(Fragment, null, createElement(CloudSignInGate, { gate }), createElement("span", { "data-holding": String(gate.holding) }));
}

async function show(laterdog: Record<string, unknown>) {
  (window as unknown as { laterdog?: unknown }).laterdog = laterdog;
  await act(async () => { root.render(createElement(Harness)); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

const text = () => host.textContent ?? "";
const gate = () => host.querySelector("[data-cloud-sign-in-gate]");
const holding = () => host.querySelector("[data-holding]")?.getAttribute("data-holding");
const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
async function click(label: string) {
  const target = button(label);
  expect(target, `button ${label}`).toBeTruthy();
  await act(async () => { target!.click(); });
  await act(async () => { await Promise.resolve(); });
}
async function type(selector: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
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
});

describe("the desktop's one calm sign-in screen", () => {
  it("opens once for a Mac that was never asked, holds the welcome flow back, and Not now hands it over", async () => {
    const bridge = makeBridge({ status: "signed-out" });
    await show({ remoteClient: { active: false }, cloudAccount: bridge });
    expect(gate()).toBeTruthy();
    expect(holding()).toBe("true");
    expect(text()).toContain("Use your email. We'll send you a code.");
    expect(text()).toContain("Agree and continue");
    expect(text()).toContain("You accept the Terms and Privacy Policy");
    await click("Use this Mac without an account");
    expect(bridge.declineOffer).toHaveBeenCalledOnce();
    expect(gate()).toBeNull();
    expect(holding()).toBe("false");
  });

  it("does not appear for a Mac that was already asked, for one signed in, or in a plain browser", async () => {
    await show({ remoteClient: { active: false }, cloudAccount: makeBridge({ status: "signed-out" }, false) });
    expect(gate()).toBeNull();
    expect(holding()).toBe("false");
    await act(async () => root.unmount());
    root = createRoot(host);
    await show({ remoteClient: { active: false }, cloudAccount: makeBridge(ready) });
    expect(gate()).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    await show({});
    expect(gate()).toBeNull();
    expect(holding()).toBe("false");
  });

  it("does not run on a page that is not this Mac's own", async () => {
    const bridge = makeBridge({ status: "signed-out" });
    await show({ cloudAccount: bridge });
    expect(gate()).toBeNull();
    expect(bridge.offer).not.toHaveBeenCalled();
  });

  it("holds the welcome flow back while the saved sign-in is still being read, and shows nothing yet", async () => {
    const bridge = makeBridge({ status: "signed-out", message: "restoring" });
    await show({ remoteClient: { active: false }, cloudAccount: bridge });
    expect(gate()).toBeNull();
    expect(holding()).toBe("true");
    await act(async () => push({ status: "signed-out" }));
    expect(gate()).toBeTruthy();
  });

  it.each([
    ["ready", ready],
    ["provisioning", { ...ready, machine: { status: "provisioning", setup: { step: "starting" } } }],
    ["full", { status: "connected", account, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } }],
    ["failed", { ...ready, machine: { status: "failed" } }],
    ["stopped", { ...ready, machine: { status: "stopped" } }],
    ["unreachable after authentication", { status: "unavailable", account, message: "unreachable" }],
  ] satisfies [string, CloudAccountState][])("finishes sign-in without moving the workspace when the home is %s", async (_home, signedIn) => {
    const bridge = makeBridge({ status: "signed-out" });
    vi.mocked(bridge.verifyCode).mockResolvedValueOnce({ ok: true, account: signedIn });
    await show({ remoteClient: { active: false }, cloudAccount: bridge });
    await type("input[type=email]", "jo@example.test");
    await click("Agree and continue");
    await type("input[autocomplete=one-time-code]", "12345678");
    expect(bridge.verifyCode).toHaveBeenCalledWith("jo@example.test", "12345678");
    expect(gate()).toBeNull();
    expect(holding()).toBe("false");
    expect(bridge.declineOffer).not.toHaveBeenCalled();
    expect(bridge.connectHome).not.toHaveBeenCalled();
    expect(bridge.connectHomeForPhone).not.toHaveBeenCalled();
    for (const next of [{ status: "signed-out" }, { status: "unavailable", account }, ready] satisfies CloudAccountState[]) {
      await act(async () => push(next));
      expect(gate()).toBeNull();
      expect(holding()).toBe("false");
    }
  });

  it("closes when an account confirmation arrives through the bridge and stays closed after later refreshes", async () => {
    const bridge = makeBridge({ status: "signed-out" });
    await show({ remoteClient: { active: false }, cloudAccount: bridge });
    await act(async () => push({ status: "connected" }));
    expect(gate()).toBeTruthy();
    expect(holding()).toBe("true");
    await act(async () => push({ status: "unavailable", account, message: "unreachable" }));
    expect(gate()).toBeTruthy();
    expect(holding()).toBe("true");
    await act(async () => push(ready));
    expect(gate()).toBeNull();
    expect(holding()).toBe("false");
    await act(async () => push({ status: "signed-out" }));
    expect(gate()).toBeNull();
    expect(holding()).toBe("false");
    expect(bridge.declineOffer).not.toHaveBeenCalled();
    expect(bridge.connectHome).not.toHaveBeenCalled();
  });
});
