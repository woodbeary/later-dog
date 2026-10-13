// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountBridge, CloudAccountState } from "../../electron/cloud-account.mjs";
import type { InstanceInfo } from "@/state/store";

const store = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: store.api,
  useStore: () => ({ state: {}, dispatch: store.dispatch }),
}));

const { nameList, signOutAccounts, signOutAll, SignOutDialog } = await import("./SignOutAll");

const account = (instanceId: string, patch: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId,
  driverKind: "claudeAgent",
  displayName: instanceId,
  snapshot: { state: "available", authenticated: true },
  models: { default: "", options: [] },
  authentication: { method: "paste-code", signOut: true },
  ...patch,
}) as InstanceInfo;

const cloud = (signOut: CloudAccountBridge["signOut"]) => ({ signOut } as unknown as CloudAccountBridge);
const signedOut: CloudAccountState = { status: "signed-out" };

beforeEach(() => {
  store.dispatch.mockReset();
  store.api.mockReset();
});

describe("what Sign out signs out", () => {
  it("takes every signed-in subscription account that can sign out here, and nothing else", () => {
    const instances = [
      account("Claude"),
      account("ChatGPT", { driverKind: "codex", authentication: { method: "device-code", signOut: true } }),
      account("Asleep", { snapshot: { state: "available", authenticated: false } }),
      account("Stuck", { authentication: { method: "paste-code" } }),
      account("Key", { snapshot: { state: "available", authenticated: true, account: { method: "api-key" } } }),
      account("Work", { managed: { organizationId: "o", organizationName: "Org" } }),
      account("Shared", { readOnly: true }),
    ];
    expect(signOutAccounts(instances, undefined).map((instance) => instance.displayName)).toEqual(["Claude", "ChatGPT"]);
  });

  it("names them the way a person would say it", () => {
    expect(nameList(["Claude"])).toBe("Claude");
    expect(nameList(["Claude", "ChatGPT"])).toBe("Claude and ChatGPT");
    expect(nameList(["Claude", "ChatGPT", "later.dog Cloud"])).toBe("Claude, ChatGPT, and later.dog Cloud");
  });
});

describe("signing out", () => {
  it("goes one account at a time, keeps going past a failure, then signs out of later.dog Cloud", async () => {
    const calls: Array<{ path: string; settle: (failure?: Error) => void }> = [];
    store.api.mockImplementation((path: string) => new Promise((resolve, reject) => {
      calls.push({ path, settle: (failure) => (failure ? reject(failure) : resolve({ instances: [account("after")] })) });
    }));
    const leave = vi.fn(async () => signedOut);
    const running = signOutAll({ accounts: [account("chat gpt"), account("claude")], cloud: cloud(leave), names: [] }, store.dispatch);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.map((call) => call.path)).toEqual(["/api/instances/chat%20gpt/auth/sign-out"]);
    calls[0]!.settle(new Error("A ChatGPT task could not stop safely."));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.map((call) => call.path)).toEqual(["/api/instances/chat%20gpt/auth/sign-out", "/api/instances/claude/auth/sign-out"]);
    expect(leave).not.toHaveBeenCalled();
    calls[1]!.settle();
    const failed = await running;
    expect(leave).toHaveBeenCalledTimes(1);
    expect(store.api).toHaveBeenCalledWith("/api/instances/claude/auth/sign-out", { method: "POST" });
    expect(store.dispatch).toHaveBeenCalledTimes(1);
    expect(store.dispatch).toHaveBeenCalledWith({ type: "instances", instances: [account("after")] });
    expect(failed).toEqual(["chat gpt did not sign out: A ChatGPT task could not stop safely."]);
  });

  it("reports later.dog Cloud when it is still signed in afterwards or refuses", async () => {
    const still = await signOutAll({ accounts: [], cloud: cloud(async () => ({ status: "unavailable", message: "signout-storage-failed" })), names: [] }, store.dispatch);
    expect(still).toEqual(["later.dog Cloud did not sign out: try again in a moment."]);
    const refused = await signOutAll({ accounts: [], cloud: cloud(async () => { throw new Error("offline"); }), names: [] }, store.dispatch);
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

  it("names everything it will sign out, keeps the dogs, and closes once done", async () => {
    let finish!: () => void;
    store.api.mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ instances: [] }); }));
    const onClose = vi.fn();
    const targets = { accounts: [account("Claude")], cloud: cloud(async () => signedOut), names: ["Claude", "later.dog Cloud"] };
    await act(async () => root.render(createElement(SignOutDialog, { targets, onClose })));
    expect(document.querySelector("#confirm-dialog-title")?.textContent).toBe("Sign out?");
    expect(document.querySelector("#confirm-dialog-body")?.textContent)
      .toBe("This signs Claude and later.dog Cloud out on this Mac. Your dogs, chats and files stay. Sign in again from Settings.");
    expect(document.activeElement).toBe(button("Cancel"));

    await act(async () => button("Sign out").click());
    expect(button("Sign out").disabled).toBe(true);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => finish());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(store.dispatch).toHaveBeenCalledWith({ type: "instances", instances: [] });
    expect(store.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("says what did not sign out", async () => {
    store.api.mockRejectedValue(new Error("Claude Code could not confirm the sign-out on this server."));
    const onClose = vi.fn();
    await act(async () => root.render(createElement(SignOutDialog, { targets: { accounts: [account("Claude")], cloud: null, names: ["Claude"] }, onClose })));
    await act(async () => button("Sign out").click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(store.dispatch).toHaveBeenCalledWith({ type: "error", message: "Claude did not sign out: Claude Code could not confirm the sign-out on this server." });
  });

  it("lets the person back out", async () => {
    const onClose = vi.fn();
    await act(async () => root.render(createElement(SignOutDialog, { targets: { accounts: [account("Claude")], cloud: null, names: ["Claude"] }, onClose })));
    await act(async () => button("Cancel").click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(store.api).not.toHaveBeenCalled();
  });
});
