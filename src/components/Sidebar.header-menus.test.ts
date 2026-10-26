import { Children, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(fixture.values[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = { current: initial };
    return fixture.values[index];
  },
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
  useLayoutEffect: () => {},
}));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("./MenuMotion", () => ({
  useMenuMotion: (open: boolean) => ({ shown: open, closing: false, className: "", exitProps: {} }),
  useHeldMenuMotion: (value: unknown) => ({ shown: value !== null, value, closing: false, className: "", exitProps: {} }),
}));
vi.mock("./DesktopCapabilities", async () => {
  const { initialDesktopCapabilities } = await import("@/lib/desktop");
  return { useDesktopCapabilities: () => ({ capabilities: initialDesktopCapabilities() }) };
});
const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: original.initialState, dispatch }) };
});

import { Sidebar } from "./Sidebar";

type Props = { children?: ReactNode; className?: string; onClick?: () => void; [key: string]: unknown };
function nodes(value: ReactNode): ReactElement<Props>[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement<Props>(child)) return [];
    return [child, ...nodes(child.props.children)];
  });
}
function render() {
  fixture.index = 0;
  fixture.effects = [];
  return nodes(Sidebar({ open: false, onClose: () => {} }));
}
const trigger = (label: string) => render().find((node) => node.type === "button" && node.props["aria-label"] === label)!;

let window: EventTarget;
const text = (tree: ReactElement<Props>[]) => tree.map((node) => Children.toArray(node.props.children).filter((child) => typeof child === "string").join(" ")).join(" ");

beforeEach(() => {
  fixture.values = [];
  dispatch.mockClear();
  window = new EventTarget();
  vi.stubGlobal("window", Object.assign(window, { innerWidth: 1280, innerHeight: 800, laterdog: undefined, setTimeout, clearTimeout }));
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("the sidebar +", () => {
  it("opens the To: picker straight away instead of a menu", () => {
    trigger("New").props.onClick!();
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleNewBot", open: true });
    const words = text(render());
    for (const gone of ["New dog", "New group chat", "Templates", "Create a pack", "Archived dogs"]) expect(words).not.toContain(gone);
  });

  it("does not cover the window with a click-eating backdrop", () => {
    trigger("New").props.onClick!();
    expect(render().some((node) => /\bfixed\b/.test(node.props.className ?? "") && /\binset-0\b/.test(node.props.className ?? ""))).toBe(false);
  });
});
