// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountBridge, CloudAccountState, CloudPlanBridge } from "../../electron/cloud-account.mjs";
import type { SignOutTargets } from "./SignOutAll";

const store = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: store.api,
  useStore: () => ({ state: {}, dispatch: store.dispatch }),
}));

const { signOutAll, SignOutDialog, useSignOutTargets } = await import("./SignOutAll");

const cloud = (signOut: CloudAccountBridge["signOut"]) => ({ signOut } as unknown as CloudAccountBridge);
const signedOut: CloudAccountState = { status: "signed-out" };

beforeEach(() => {
  store.dispatch.mockReset();
  store.api.mockReset();
});

describe("signing out", () => {
  it("signs out of later.dog only and leaves every Claude and ChatGPT sign-in alone", async () => {
    const leave = vi.fn(async () => signedOut);
    expect(await signOutAll({ cloud: cloud(leave) })).toEqual([]);
    expect(leave).toHaveBeenCalledTimes(1);
    expect(store.api).not.toHaveBeenCalled();
    expect(store.dispatch).not.toHaveBeenCalled();
  });

  it("reports later.dog Cloud when it is still signed in afterwards or refuses", async () => {
    const still = await signOutAll({ cloud: cloud(async () => ({ status: "unavailable", message: "signout-storage-failed" })) });
    expect(still).toEqual(["later.dog Cloud did not sign out: try again in a moment."]);
    const refused = await signOutAll({ cloud: cloud(async () => { throw new Error("offline"); }) });
    expect(refused).toEqual(["later.dog Cloud did not sign out: offline"]);
    expect(store.api).not.toHaveBeenCalled();
  });

  it("signs out of later.dog only through the Cloud home page's plan bridge, which answers with nothing", async () => {
    const leave = vi.fn(async () => {});
    expect(await signOutAll({ cloud: { signOut: leave } })).toEqual([]);
    expect(leave).toHaveBeenCalledTimes(1);
    expect(store.api).not.toHaveBeenCalled();
    expect(store.dispatch).not.toHaveBeenCalled();
    const refused = await signOutAll({ cloud: { signOut: async () => { throw new Error("Choose Sign out to sign out."); } } });
    expect(refused).toEqual(["later.dog Cloud did not sign out: Choose Sign out to sign out."]);
  });
});

describe("what Sign out reaches", () => {
  let root: Root;
  let seen: SignOutTargets | null;
  const Probe = () => { seen = useSignOutTargets(); return null; };
  const account = (state: CloudAccountState) => ({
    state: vi.fn(async () => state),
    onState: vi.fn(() => () => {}),
    signOut: vi.fn(async () => signedOut),
  }) as unknown as CloudAccountBridge;
  const plan = (state: CloudPlanBridge["state"]) => ({ state: vi.fn(state), manage: vi.fn(async () => {}), signOut: vi.fn(async () => {}) }) as CloudPlanBridge;
  const targetsOn = async (laterdog: Record<string, unknown>) => {
    vi.stubGlobal("laterdog", laterdog);
    await act(async () => root.render(createElement(Probe)));
    return seen;
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    seen = null;
    root = createRoot(document.createElement("div"));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it("uses this Mac's Cloud account while it is signed in, and never the plan bridge beside it", async () => {
    const connected = account({ status: "connected", account: { id: "a1", email: "a@example.test" } });
    const beside = plan(async () => ({ status: "none" }));
    expect((await targetsOn({ cloudAccount: connected, cloudPlan: beside }))?.cloud).toBe(connected);
    expect(beside.state).not.toHaveBeenCalled();
  });

  it("offers nothing once this Mac's Cloud account is signed out, even with the plan bridge beside it", async () => {
    expect((await targetsOn({ cloudAccount: account(signedOut), cloudPlan: plan(async () => ({ status: "none" })) }))?.cloud).toBeNull();
  });

  it("falls back to the plan bridge on the Cloud home page, where this Mac's account bridge is not offered", async () => {
    const home = plan(async () => ({ status: "paid", tier: "pro" }));
    const targets = await targetsOn({ cloudPlan: home });
    expect(targets?.cloud).toBe(home);
    expect(await signOutAll(targets!)).toEqual([]);
    expect(home.signOut).toHaveBeenCalledTimes(1);
    expect(store.api).not.toHaveBeenCalled();
  });

  it("offers nothing on another server's page, where the desktop does not answer the plan bridge", async () => {
    const elsewhere = plan(async () => { throw new Error("cloud-plan:state is only available in this app's window"); });
    expect((await targetsOn({ cloudPlan: elsewhere }))?.cloud).toBeNull();
    expect(elsewhere.state).toHaveBeenCalledTimes(1);
  });

  it("offers nothing to a desktop showing another Mac", async () => {
    const home = plan(async () => ({ status: "none" }));
    expect((await targetsOn({ remoteClient: { active: true }, cloudPlan: home }))?.cloud).toBeNull();
    expect(home.state).not.toHaveBeenCalled();
  });
});

describe("the Sign out question", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  const button = (label: string) => [...document.querySelectorAll("button")].find((element) => element.textContent === label)!;

  it("names later.dog alone, keeps the dogs, and closes once done", async () => {
    let finish!: () => void;
    const onClose = vi.fn();
    const targets = { cloud: cloud(() => new Promise<CloudAccountState>((resolve) => { finish = () => resolve(signedOut); })) };
    await act(async () => root.render(createElement(SignOutDialog, { targets, onClose })));
    expect(document.querySelector("#confirm-dialog-title")?.textContent).toBe("Sign out?");
    expect(document.querySelector("#confirm-dialog-body")?.textContent)
      .toBe("This signs later.dog Cloud out on this Mac. Your dogs, chats and files stay. Sign in again from Settings.");
    expect(document.activeElement).toBe(button("Cancel"));

    await act(async () => button("Sign out").click());
    expect(button("Sign out").disabled).toBe(true);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => finish());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(store.api).not.toHaveBeenCalled();
    expect(store.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("says what did not sign out", async () => {
    const onClose = vi.fn();
    await act(async () => root.render(createElement(SignOutDialog, { targets: { cloud: cloud(async () => { throw new Error("offline"); }) }, onClose })));
    await act(async () => button("Sign out").click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(store.dispatch).toHaveBeenCalledWith({ type: "error", message: "later.dog Cloud did not sign out: offline" });
  });

  it("lets the person back out", async () => {
    const onClose = vi.fn();
    const leave = vi.fn(async () => signedOut);
    await act(async () => root.render(createElement(SignOutDialog, { targets: { cloud: cloud(leave) }, onClose })));
    await act(async () => button("Cancel").click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(leave).not.toHaveBeenCalled();
  });
});
