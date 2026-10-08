import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { DesktopPermissionChecklist } from "@/lib/desktop-permissions";
import { PermissionChecklist } from "./PermissionChecklist";

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

const handlers = { onRequest: vi.fn(), onOpenSettings: vi.fn(), onRelaunch: vi.fn() };
function render(props: Partial<Parameters<typeof PermissionChecklist>[0]>) {
  let tree: ReactNode = null;
  function Capture() {
    tree = PermissionChecklist({ host: "mac", checklist: null, busy: null, ...handlers, ...props });
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  const row = (permission: string) => all.find((node) => node.props["data-permission"] === permission)!;
  const buttons = (permission: string) => nodes(row(permission).props.children).filter((node) => node.type === "button");
  // the pill is its own component, so its words are read off the markup of that row
  const pill = (permission: string) => {
    const start = html.indexOf(`data-permission="${permission}"`);
    const next = html.indexOf("data-permission=", start + 1);
    const markup = html.slice(start, next < 0 ? undefined : next);
    return markup.match(/data-testid="permission-status"[^>]*>(.*?)<\/span>/)?.[1]?.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
  };
  return { html, row, buttons, pill };
}
const checklist = (patch: Partial<DesktopPermissionChecklist> = {}): DesktopPermissionChecklist =>
  ({ microphone: "granted", accessibility: "granted", screen: "granted", ...patch });

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
});

describe("the permissions checklist", () => {
  it("draws one row per grant with plain words, and says it is checking until the bridge answers", () => {
    const rendered = render({});
    expect([...rendered.html.matchAll(/data-permission="([^"]+)"/g)].map((match) => match[1])).toEqual(["microphone", "accessibility", "screen"]);
    expect(rendered.html).toContain("Microphone &amp; speech");
    expect(rendered.html).toContain("Voice dictation into the composer, transcribed on-device.");
    expect(rendered.html).toContain("A dog can click and type on this Mac.");
    expect(rendered.html).toContain("A dog can see this Mac&#x27;s screen.");
    for (const permission of ["microphone", "accessibility", "screen"]) {
      expect(rendered.pill(permission)).toBe("Checking…");
      expect(rendered.buttons(permission)).toEqual([]);
    }
  });

  it("offers one action per row, says why a grant that looks on may not apply, and keeps the relaunch note", () => {
    const rendered = render({ checklist: checklist({ microphone: "notDetermined", accessibility: "denied", screen: "denied" }) });
    const labels = (permission: string) => rendered.buttons(permission).map((node) => text(node.props.children));
    const button = (permission: string, label: string) => rendered.buttons(permission).find((node) => text(node.props.children) === label)!;
    // the action already says the switch is off, so no status pill beside it
    expect(rendered.pill("microphone")).toBeUndefined();
    expect(labels("microphone")).toEqual(["Enable"]);
    button("microphone", "Enable").props.onClick!();
    expect(handlers.onRequest).toHaveBeenCalledWith("microphone");

    // Accessibility's own prompt adds later.dog to the list and opens the pane: Enable alone
    expect(labels("accessibility")).toEqual(["Enable"]);
    button("accessibility", "Enable").props.onClick!();
    expect(handlers.onRequest).toHaveBeenCalledWith("accessibility");
    expect(rendered.html).toContain("Already on in System Settings? Until later.dog is signed, macOS ties the switch to each build");

    // a denied Screen Recording is never re-prompted: System Settings, the cache note, and (in Settings) a relaunch
    expect(labels("screen").sort()).toEqual(["Open System Settings", "Relaunch later.dog"]);
    // one note per row: the stale-build hint stands in for the relaunch sentence, the relaunch link follows it
    expect(rendered.html).not.toContain("macOS applies a new Screen Recording grant after later.dog reopens.");
    const asked = render({ checklist: checklist({ screen: "notDetermined" }) });
    expect(asked.html).toContain("macOS applies a new Screen Recording grant after later.dog reopens.");
    button("screen", "Open System Settings").props.onClick!();
    expect(handlers.onOpenSettings).toHaveBeenCalledWith("screen");
    button("screen", "Relaunch later.dog").props.onClick!();
    expect(handlers.onRelaunch).toHaveBeenCalledOnce();
  });

  it("marks a granted row and offers it nothing more", () => {
    const rendered = render({ checklist: checklist() });
    for (const permission of ["microphone", "accessibility", "screen"]) {
      expect(rendered.pill(permission)).toBe("Allowed");
      expect(rendered.buttons(permission)).toEqual([]);
    }
    expect(rendered.html).not.toContain("Screen Recording grant after");
  });

  it("holds the other rows while one prompt is open", () => {
    const rendered = render({ checklist: checklist({ microphone: "notDetermined", screen: "notDetermined" }), busy: "screen" });
    const enable = (permission: string) => rendered.buttons(permission).find((node) => text(node.props.children) === "Enable")!;
    expect(enable("microphone").props.disabled).toBe(true);
    expect(enable("screen").props.disabled).toBe(true);
    expect(rendered.html).toContain("animate-spin");
  });

  it("degrades to desktop-only words without the bridge, and to nothing-to-flip off a Mac", () => {
    const browser = render({ host: "browser", checklist: null });
    expect(browser.html).toContain("These are given in the desktop app, on the Mac that runs later.dog.");
    for (const permission of ["microphone", "accessibility", "screen"]) {
      expect(browser.pill(permission)).toBe("Available in the desktop app");
      expect(browser.buttons(permission)).toEqual([]);
    }
    const other = render({ host: "other", checklist: checklist({ screen: "denied" }) });
    expect(other.html).toContain("this computer has none to flip");
    expect(other.pill("screen")).toBe("Not needed on this computer");
    expect(other.buttons("screen")).toEqual([]);
  });

  it("staggers the rows only where the welcome tour asks it to", () => {
    expect(render({ stagger: true }).row("screen").props.className).toContain("animate-rise");
    expect(render({}).row("screen").props.className).not.toContain("animate-rise");
  });
});
