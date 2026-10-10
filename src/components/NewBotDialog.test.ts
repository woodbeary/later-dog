import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[],
  index: 0,
  effects: [] as EffectCallback[],
  dispatch: vi.fn(),
  api: vi.fn(),
  storeState: {} as Record<string, unknown>,
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
}));
vi.mock("@/state/store", async (importOriginal) => {
  const store = await importOriginal<typeof import("@/state/store")>();
  return { ...store, api: fixture.api, useStore: () => ({ state: { ...store.initialState, ...fixture.storeState }, dispatch: fixture.dispatch }) };
});
import { NewBotDialog } from "./NewBotDialog";

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function render(props: Parameters<typeof NewBotDialog>[0] = {}) {
  fixture.effects = [];
  let tree: ReactNode = null;
  function Capture() { fixture.index = 0; tree = NewBotDialog(props); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
const runEffects = () => { for (const effect of fixture.effects) effect(); };
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const find = (rendered: { nodes: Node[] }, attr: string, value: unknown = true) =>
  rendered.nodes.find((node) => node.props[attr] === value)!;
const button = (rendered: { nodes: Node[] }, text: string) =>
  rendered.nodes.find((node) => node.type === "button" && nodes(node).concat(node).some((child) => child.props.children === text)
    || (node.type === "button" && Array.isArray(node.props.children) && node.props.children.includes(text)))!;
const change = (node: Node, value: string) => (node.props.onChange as (e: unknown) => void)({ target: { value } });
const submit = (rendered: { nodes: Node[] }) => (rendered.nodes.find((node) => node.type === "form")!.props.onSubmit as (e: unknown) => void)({ preventDefault: () => {} });
const lastNewBot = () => fixture.dispatch.mock.calls.map(([action]) => action).findLast((action) => action.type === "newBot")!;

beforeEach(() => {
  fixture.values = [];
  fixture.index = 0;
  fixture.effects = [];
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.api.mockReturnValue(new Promise(() => {}));
  fixture.storeState = {};
  vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("Node", class {});
});
afterEach(() => vi.unstubAllGlobals());

describe("the new dog dialog", () => {
  it("is one card: a name, what it should help with, Create — nothing else", () => {
    const { html, nodes: tree } = render();
    expect(html).toContain('aria-label="New dog"');
    expect(html).toContain(">Name</label>");
    expect(html).toContain(">What should it help with?</label>");
    expect(find({ nodes: tree }, "id", "new-dog-name").props.maxLength).toBe(100);
    expect(find({ nodes: tree }, "id", "new-dog-purpose").props.maxLength).toBeGreaterThan(0);
    expect(tree.filter((node) => node.type === "input")).toHaveLength(2);
    expect(tree.filter((node) => node.type === "select")).toHaveLength(0);
    for (const gone of ["Starting role", "Pack", "Who can see it", "Defaults for new dogs", "Identity", "Soul", "Tricks", "Routines", "Permissions", "Voice"]) {
      expect(html).not.toContain(gone);
    }
    expect(button({ nodes: tree }, "Create dog").props.disabled).toBe(true);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("prefills the host's suggested name and sends its model back with the one create", async () => {
    const model = { instanceId: "claude", model: "claude-sonnet-5" };
    fixture.api.mockResolvedValue({ modelSelection: model, suggestedName: "Biscuit" });
    render();
    runEffects();
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/bot-defaults");
    await flush();
    const filled = render();
    expect(filled.html).toContain('value="Biscuit"');
    expect(button(filled, "Create dog").props.disabled).toBe(false);
    change(find(filled, "id", "new-dog-purpose"), "  planning trips ");
    submit(render());
    expect(lastNewBot()).toMatchObject({
      type: "newBot", name: "Biscuit", title: "planning trips", modelSelection: model, section: undefined, preserveSelection: false,
    });
    expect(fixture.api).toHaveBeenCalledTimes(1);
  });

  it("keeps a name the person already typed over the suggestion, and leaves the title out when blank", async () => {
    fixture.api.mockResolvedValue({ modelSelection: { instanceId: "claude", model: "x" }, suggestedName: "Biscuit" });
    change(find(render(), "id", "new-dog-name"), "Nova");
    runEffects();
    await flush();
    const filled = render();
    expect(filled.html).toContain('value="Nova"');
    submit(filled);
    expect(lastNewBot()).toMatchObject({ name: "Nova" });
    expect("title" in lastNewBot() && lastNewBot().title).toBeFalsy();
  });

  it("carries the team and selection flags for callers that create inside a team", () => {
    const onCreated = vi.fn();
    const rendered = render({ section: "Studio", preserveSelection: true, onCreated });
    change(find(rendered, "id", "new-dog-name"), "Rex");
    submit(render({ section: "Studio", preserveSelection: true, onCreated }));
    expect(lastNewBot()).toMatchObject({ name: "Rex", section: "Studio", preserveSelection: true });
  });

  it("creates on the companion's single permitted request, without asking for host defaults", () => {
    vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {}, laterdog: { remoteClient: { active: true } } });
    const rendered = render();
    runEffects();
    expect(fixture.api).not.toHaveBeenCalled();
    change(find(rendered, "id", "new-dog-name"), "Rex");
    submit(render());
    expect(lastNewBot()).toMatchObject({ name: "Rex", modelSelection: undefined });
  });

  it.each([false, true])("closes after a successful creation even when its caller fails (async=%s)", async (asyncFailure) => {
    const failed = () => { throw new Error("Caller failed"); };
    const rendered = render({ onCreated: asyncFailure ? async () => failed() : failed });
    change(find(rendered, "id", "new-dog-name"), "Rex");
    submit(render({ onCreated: asyncFailure ? async () => failed() : failed }));
    const bot = { id: "created", name: "Rex" } as Bot;
    (lastNewBot().onCreated as (bot: Bot) => void)(bot);
    await flush();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleNewBot", open: false });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "error", message: "Caller failed" });
  });

  it("closes through the caller's onClose when it has one", () => {
    const onClose = vi.fn();
    const rendered = render({ onClose });
    change(find(rendered, "id", "new-dog-name"), "Rex");
    submit(render({ onClose }));
    (lastNewBot().onCreated as (bot: Bot) => void)({ id: "created", name: "Rex" } as Bot);
    expect(onClose).toHaveBeenCalledOnce();
    expect(fixture.dispatch).not.toHaveBeenCalledWith({ type: "toggleNewBot", open: false });
  });

  it("shows the server's reason when creation fails and lets the person try again", () => {
    const rendered = render();
    change(find(rendered, "id", "new-dog-name"), "Rex");
    submit(render());
    (lastNewBot().onError as (message: string) => void)("No engine is signed in.");
    const failed = render();
    expect(find(failed, "role", "alert").props.children).toBe("No engine is signed in.");
    expect(button(failed, "Create dog").props.disabled).toBe(false);
  });

  it("waits while a creation is pending and can be dismissed without creating", () => {
    fixture.storeState = { botCreationPending: true };
    const rendered = render();
    expect(find(rendered, "role", "dialog").props["aria-busy"]).toBe(true);
    expect(find(rendered, "id", "new-dog-name").props.disabled ?? rendered.nodes.find((node) => node.type === "fieldset")!.props.disabled).toBe(true);
    submit(rendered);
    expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "newBot" }));
    const close = find(rendered, "aria-label", "Close");
    expect(close.props.title).toBe("Close");
    (close.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "toggleNewBot", open: false });
  });

  it("keeps Escape and backward Tab inside the dialog", () => {
    const listeners: Record<string, (event: unknown) => void> = {};
    vi.stubGlobal("window", { addEventListener: (name: string, fn: (event: unknown) => void) => { listeners[name] = fn; }, removeEventListener: () => {} });
    const rendered = render();
    const first = { focus: vi.fn(), getClientRects: () => [{}] };
    const last = { focus: vi.fn(), getClientRects: () => [{}] };
    const root = { focus: vi.fn(), contains: () => true, querySelectorAll: () => [first, last] };
    (find(rendered, "role", "dialog").props.ref as { current: unknown }).current = root;
    vi.stubGlobal("document", { activeElement: first });
    runEffects();
    const preventDefault = vi.fn();
    listeners.keydown!({ key: "Tab", shiftKey: true, target: first, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(last.focus).toHaveBeenCalledOnce();
    listeners.keydown!({ key: "Escape", target: first, preventDefault });
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleNewBot", open: false });
  });
});
