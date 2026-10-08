import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { DesktopPermissionChecklist } from "@/lib/desktop-permissions";
import type { PermissionChecklist } from "@/components/PermissionChecklist";

// The hook owns the bridge round trips and the rows their own words (each
// has its own test); the beat is what it hands them and what its buttons do.
const hook = vi.hoisted(() => ({
  checklist: null as DesktopPermissionChecklist | null,
  busy: null,
  request: vi.fn(async () => {}),
  openSettings: vi.fn(async () => {}),
  refresh: vi.fn(async () => {}),
  active: [] as boolean[],
}));
vi.mock("@/lib/use-desktop-permissions", () => ({
  useDesktopPermissions: (options: { active?: boolean }) => {
    hook.active.push(options.active ?? true);
    return hook;
  },
}));
const rows = vi.hoisted(() => ({ props: [] as Array<Parameters<typeof PermissionChecklist>[0]> }));
vi.mock("@/components/PermissionChecklist", () => ({
  PermissionChecklist: (props: Parameters<typeof PermissionChecklist>[0]) => {
    rows.props.push(props);
    return `ROWS:${props.host}:${props.checklist ? "answered" : "checking"};`;
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
}));
import { PermissionsBeat } from "./PermissionsBeat";
import { PrimaryButton, QuietButton } from "./shared";

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
const props = { onNext: vi.fn(), onSkip: vi.fn(), setMascot: vi.fn(), bump: vi.fn() };
function render() {
  let tree: ReactNode = null;
  function Capture() {
    tree = PermissionsBeat(props);
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  const button = (type: typeof PrimaryButton | typeof QuietButton, label: string) =>
    all.find((node) => node.type === type && text(node.props.children) === label);
  return { html, button, rows: rows.props.at(-1)! };
}
const bridge = { status: vi.fn(async () => ({})), request: vi.fn(async () => ({})), openSettings: vi.fn(async () => true) };

beforeEach(() => {
  vi.clearAllMocks();
  hook.checklist = null;
  hook.active = [];
  rows.props = [];
  setLocale("en");
});
afterEach(() => vi.unstubAllGlobals());

describe("the permissions beat", () => {
  it("hands a Mac's live checklist to the rows, wires Enable and the Settings link to the bridge, and keeps Skip for now", () => {
    vi.stubGlobal("window", { laterdog: { platform: "darwin", permissions: bridge } });
    hook.checklist = { microphone: "granted", accessibility: "denied", screen: "notDetermined" };
    const rendered = render();
    expect(hook.active).toEqual([true]);
    expect(rendered.html).toContain("Optional, and only ever used when you ask for the feature.");
    expect(rendered.html).toContain("ROWS:mac:answered;");
    expect(rendered.rows.checklist).toEqual(hook.checklist);
    expect(rendered.rows.stagger).toBe(true);
    // the welcome tour offers no relaunch mid-flow; Settings does
    expect(rendered.rows.onRelaunch).toBeUndefined();
    rendered.rows.onRequest("accessibility");
    expect(hook.request).toHaveBeenCalledWith("accessibility");
    rendered.rows.onOpenSettings("screen");
    expect(hook.openSettings).toHaveBeenCalledWith("screen");
    rendered.button(QuietButton, "Skip for now")!.props.onClick!();
    expect(props.onSkip).toHaveBeenCalledOnce();
    rendered.button(PrimaryButton, "Continue")!.props.onClick!();
    expect(props.onNext).toHaveBeenCalledOnce();
  });

  it("tells the rows a browser has no bridge, and asks it for nothing", () => {
    vi.stubGlobal("window", {});
    const rendered = render();
    expect(hook.active).toEqual([false]);
    expect(rendered.html).toContain("ROWS:browser:checking;");
    expect(rendered.button(QuietButton, "Skip for now")).toBeDefined();
  });

  it("tells the rows another desktop has nothing to flip", () => {
    vi.stubGlobal("window", { laterdog: { platform: "win32", permissions: bridge } });
    const rendered = render();
    expect(hook.active).toEqual([false]);
    expect(rendered.html).toContain("ROWS:other:checking;");
  });
});
