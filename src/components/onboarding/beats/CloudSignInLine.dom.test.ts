// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountBridge, CloudAccountState } from "../../../../electron/cloud-account.mjs";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ api: vi.fn(async () => ({ onboarding: { completedAt: "now", version: 9 } })), dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: {}, dispatch: fixture.dispatch }) }));
import { CloudSignInLine } from "./CloudSignInLine";

const ready: CloudAccountState = {
  status: "connected", account: { id: "u", email: "jo@example.test" },
  entitlement: { plan: "pro", tier: "beta", status: "active", expiresAt: 1_900_000_000_000, version: 1 },
  machine: { status: "ready", origin: "https://h1-home.later.dog" },
};

let host: HTMLDivElement;
let root: Root;
let push: (state: CloudAccountState) => void;

function bridgeWith(initial: CloudAccountState): CloudAccountBridge {
  return {
    state: vi.fn(async () => initial),
    begin: vi.fn(async () => ({ status: "connecting", enrollment: { userCode: "KQ7RM-T4XWP", expiresAt: Date.now() + 600_000 } }) as CloudAccountState),
    signInAgain: vi.fn(), reopen: vi.fn(), cancel: vi.fn(), refresh: vi.fn(), signOut: vi.fn(), openDashboard: vi.fn(),
    connectHome: vi.fn(async () => ready), connectHomeForPhone: vi.fn(),
    onState: vi.fn((callback) => { push = callback; return () => {}; }),
  } as unknown as CloudAccountBridge;
}

async function show(laterdog?: Record<string, unknown>) {
  (window as unknown as { laterdog?: unknown }).laterdog = laterdog;
  await act(async () => { root.render(createElement(CloudSignInLine)); });
  await act(async () => { await Promise.resolve(); });
}

const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label);

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture.api.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as { laterdog?: unknown }).laterdog;
});

describe("the welcome step for someone who already uses the iPhone app", () => {
  it("signs in, then finishes the welcome and opens My Cloud once it's ready", async () => {
    const cloudAccount = bridgeWith({ status: "signed-out" });
    await show({ cloudAccount });
    expect(host.textContent).toContain("Use later.dog on your iPhone?");
    await act(async () => { button("Sign in")!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(cloudAccount.begin).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("KQ7RM-T4XWP");
    await act(async () => push({ ...ready, machine: { status: "provisioning" } }));
    expect(host.textContent).toContain("Setting up My Cloud");
    expect(cloudAccount.connectHome).not.toHaveBeenCalled();
    await act(async () => push(ready));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fixture.api).toHaveBeenCalledWith("/api/config", expect.objectContaining({ method: "PUT" }));
    expect(cloudAccount.connectHome).toHaveBeenCalledOnce();
  });

  it("offers Open My Cloud when this Mac is already signed in", async () => {
    const cloudAccount = bridgeWith(ready);
    await show({ cloudAccount });
    await act(async () => { button("Open My Cloud")!.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(cloudAccount.begin).not.toHaveBeenCalled();
    expect(cloudAccount.connectHome).toHaveBeenCalledOnce();
  });

  it("stays out of the way where Cloud sign-in isn't available", async () => {
    await show({});
    expect(host.querySelector("[data-cloud-signin-line]")).toBeNull();
  });
});
