// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const desktop = vi.hoisted(() => ({ value: null as null | { capabilities: { remote?: boolean; host: { name?: string } }; ready: boolean } }));
vi.mock("./DesktopCapabilities", async (original) => {
  const actual = await original<typeof import("./DesktopCapabilities")>();
  return { ...actual, useDesktopCapabilities: () => desktop.value ?? actual.useDesktopCapabilities() };
});

const { ThisComputerRow, computerName } = await import("./ComputerSettings");

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  desktop.value = null;
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

describe("the computer's name", () => {
  it("is the host's name without the .local a Mac adds, and nothing when there is none", () => {
    expect(computerName("Jacobs-MacBook-Pro.local")).toBe("Jacobs-MacBook-Pro");
    expect(computerName("  studio  ")).toBe("studio");
    expect(computerName("my.local.box")).toBe("my.local.box");
    expect(computerName(".local")).toBeNull();
    expect(computerName("   ")).toBeNull();
    expect(computerName(42)).toBeNull();
    expect(computerName(undefined)).toBeNull();
  });

  it("reads it from the server and says This computer until then, or when it can't", async () => {
    let answer!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; }));
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(createElement(ThisComputerRow)));
    expect(host.textContent).toBe("This computer");
    expect(fetch).toHaveBeenCalledWith("/.well-known/laterdog/environment", expect.anything());
    await act(async () => answer(new Response(JSON.stringify({ label: "Jacobs-MacBook-Pro.local" }), { status: 200 })));
    await settle();
    expect(host.textContent).toBe("Jacobs-MacBook-Pro");

    await act(async () => root.unmount());
    root = createRoot(host);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await act(async () => root.render(createElement(ThisComputerRow)));
    await settle();
    expect(host.textContent).toBe("This computer");
  });

  it("takes this Mac's own name from the app, so the Cloud's window never shows the home's host name", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ label: "home-7f3a9c" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    desktop.value = { capabilities: { remote: true, host: { name: "Jo's MacBook Air" } }, ready: true };
    await act(async () => root.render(createElement(ThisComputerRow)));
    await settle();
    expect(host.textContent).toBe("Jo's MacBook Air");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says This computer on a remote page the app gave no name, without asking that server", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ label: "home-7f3a9c" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    desktop.value = { capabilities: { remote: true, host: {} }, ready: true };
    await act(async () => root.render(createElement(ThisComputerRow)));
    await settle();
    expect(host.textContent).toBe("This computer");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("waits for the app's answer before asking the server", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ label: "home-7f3a9c" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    desktop.value = { capabilities: { host: {} }, ready: false };
    await act(async () => root.render(createElement(ThisComputerRow)));
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(host.textContent).toBe("This computer");
  });
});
