import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  credentialStore: undefined as "ok" | "unavailable" | undefined,
  relaunch: vi.fn(() => Promise.resolve(true)),
}));
vi.stubGlobal("window", { laterdog: { relaunch: fixture.relaunch } });
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
});

describe("the saved sign-ins notice", () => {
  it("stays away while the store unlocked, and where the page is not told", () => {
    expect(render().html).toBe("");
    fixture.credentialStore = "ok";
    expect(render().html).toBe("");
  });

  it("says what to do when macOS kept the saved sign-ins locked, and the relaunch is one click", () => {
    fixture.credentialStore = "unavailable";
    const rendered = render();
    expect(rendered.html).toContain('data-testid="credential-store-notice"');
    expect(rendered.html).toContain("Saved sign-ins are locked");
    expect(rendered.html).toContain("Quit and reopen later.dog, then choose Always Allow when it asks.");
    rendered.button("Quit and reopen")!.props.onClick!();
    expect(fixture.relaunch).toHaveBeenCalledOnce();
    expect(rendered.button("Later")).toBeDefined();
  });
});
