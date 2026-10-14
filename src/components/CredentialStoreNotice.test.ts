import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  credentialStore: undefined as "ok" | "unavailable" | undefined,
  relaunch: vi.fn(() => Promise.resolve(true)),
  retry: vi.fn<() => Promise<{ available: boolean }>>(),
  values: [] as unknown[],
  index: 0,
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (value: unknown) => { fixture.values[index] = value; }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = { current: initial };
    return fixture.values[index];
  },
}));
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ ready: true, capabilities: { host: { platform: "darwin" }, credentialStore: fixture.credentialStore } }),
}));

const { CredentialStoreNotice } = await import("./CredentialStoreNotice");
afterAll(() => vi.unstubAllGlobals());

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode; onClick?: () => void }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function text(value: ReactNode): string {
  return Children.toArray(value).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    return isValidElement(child) ? text((child as Node).props.children) : "";
  }).join("").trim();
}
function render() {
  fixture.index = 0;
  let tree: ReactNode = null;
  function Capture() {
    tree = CredentialStoreNotice();
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  const button = (label: string) => nodes(tree).find((node) => node.type === "button" && text(node.props.children) === label);
  return { html, button };
}

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  fixture.credentialStore = undefined;
  fixture.values = [];
  fixture.retry.mockReset();
  vi.stubGlobal("window", { laterdog: { relaunch: fixture.relaunch, retryCredentialStore: fixture.retry } });
});

const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };

describe("the saved sign-ins notice", () => {
  it("stays away while the store unlocked, and where the page is not told", () => {
    expect(render().html).toBe("");
    fixture.credentialStore = "ok";
    expect(render().html).toBe("");
  });

  it("retries in place once, disables actions while waiting, and closes after recovery", async () => {
    fixture.credentialStore = "unavailable";
    let resolve!: (result: { available: boolean }) => void;
    fixture.retry.mockReturnValue(new Promise((done) => { resolve = done; }));
    const retry = render().button("Try unlocking again")!;
    retry.props.onClick!();
    retry.props.onClick!();
    expect(fixture.retry).toHaveBeenCalledOnce();
    expect(render().button("Try unlocking again")!.props.disabled).toBe(true);
    expect(render().button("Quit and reopen")!.props.disabled).toBe(true);
    resolve({ available: true });
    await flush();
    expect(render().html).toBe("");
    expect(fixture.relaunch).not.toHaveBeenCalled();
  });

  it.each([false, new Error("Error invoking remote method 'credential:retry': native failure")])("keeps retry and relaunch available after a failed read (%s)", async (result) => {
    fixture.credentialStore = "unavailable";
    if (result === false) fixture.retry.mockResolvedValue({ available: false });
    else fixture.retry.mockRejectedValue(result);
    render().button("Try unlocking again")!.props.onClick!();
    await flush();
    const view = render();
    expect(view.html).toContain('role="alert"');
    expect(view.html).toContain("Saved sign-ins still cannot be read");
    expect(view.html).not.toContain("Error invoking");
    expect(view.button("Try unlocking again")!.props.disabled).toBe(false);
    expect(view.button("Quit and reopen")!.props.disabled).toBe(false);
  });

  it("keeps the relaunch fallback when retry is not supported", () => {
    fixture.credentialStore = "unavailable";
    vi.stubGlobal("window", { laterdog: { relaunch: fixture.relaunch } });
    expect(render().button("Try unlocking again")).toBeUndefined();
    expect(render().button("Quit and reopen")).toBeDefined();
  });

  it("offers neutral recovery guidance and a one-click relaunch when saved sign-ins cannot be read", () => {
    fixture.credentialStore = "unavailable";
    const rendered = render();
    expect(rendered.html).toContain('data-testid="credential-store-notice"');
    expect(rendered.html).toContain("Saved sign-ins are locked");
    expect(rendered.html).toContain("Saved sign-ins could not be read. Try unlocking again, or quit and reopen later.dog. Allow keychain access if asked.");
    rendered.button("Quit and reopen")!.props.onClick!();
    expect(fixture.relaunch).toHaveBeenCalledOnce();
    expect(rendered.button("Later")).toBeDefined();
  });
});
