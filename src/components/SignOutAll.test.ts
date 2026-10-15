// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountBridge, CloudAccountState } from "../../electron/cloud-account.mjs";

const store = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: store.api,
  useStore: () => ({ state: {}, dispatch: store.dispatch }),
}));

const { signOutAll, SignOutDialog } = await import("./SignOutAll");

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
