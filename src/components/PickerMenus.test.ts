// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { setLocale } from "@/lib/i18n";
import { AccountMenu } from "./AccountMenu";
import { ComposerPlusMenu } from "./ComposerPlusMenu";
import { distinctModels, ModelMenu, splitModels } from "./ModelMenu";

const instance = (instanceId: string, driverKind: string, displayName: string): InstanceInfo => ({
  instanceId, driverKind, displayName, snapshot: { state: "available", authenticated: true },
  models: { default: "", options: [] }, capabilities: {},
}) as unknown as InstanceInfo;
const kimi = instance("laterdogAi", "laterdogAi", "Kimi");
const grok = instance("laterdogGrok", "laterdogGrok", "Grok");
const claude = instance("claude", "claudeAgent", "Claude");

beforeEach(() => setLocale("en"));

describe("the header's account menu", () => {
  it("lists accounts only, one row each, the current one checked", () => {
    const html = renderToStaticMarkup(createElement(AccountMenu, {
      rows: [{ instance: claude, label: "Claude", selected: false }, { instance: kimi, label: "Kimi", selected: true }],
      onPick: () => {},
    }));
    expect(html.match(/data-account-row=/g)).toHaveLength(2);
    expect(html).toContain('aria-checked="true"');
    expect(html).not.toMatch(/Kimi K2\.6|Sonnet|Fast mode|Manage/);
  });
});

describe("reordering in the header's account menu", () => {
  const work = instance("claude-work", "claudeAgent", "Work");
  const rows = [
    { instance: claude, label: "Claude", selected: true, movable: true },
    { instance: work, label: "Work", selected: false, movable: true },
    { instance: kimi, label: "Kimi", selected: false },
  ];
  let host: HTMLDivElement;
  let root: Root;
  const item = (id: string) => host.querySelector<HTMLButtonElement>(`[data-account-row="${id}"]`)!;
  const press = async (target: Element, key: string, altKey = true) => {
    await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, altKey, bubbles: true, cancelable: true })); });
  };
  const drag = async (target: Element, kind: "dragstart" | "dragover" | "drop" | "dragend", transfer: DataTransfer) => {
    const event = new Event(kind, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    await act(async () => { target.dispatchEvent(event); });
  };
  const order = () => [...host.querySelectorAll<HTMLElement>("[data-account-row]")].map((element) => element.dataset.accountRow);
  const show = async (onReorder?: (ids: string[]) => void) => {
    await act(async () => root.render(createElement(AccountMenu, { rows, onPick: () => {}, onReorder })));
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("moves an account among its own kind with Alt and the arrows, with a grip only where it can go", async () => {
    const onReorder = vi.fn();
    await show(onReorder);
    expect(host.querySelectorAll("[data-account-grip]")).toHaveLength(2);
    expect(item("claude").getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowUp Alt+ArrowDown");
    expect(item("laterdogAi").getAttribute("aria-keyshortcuts")).toBeNull();
    await press(item("claude"), "ArrowDown", false);
    await press(item("claude"), "ArrowUp");
    await press(item("claude-work"), "ArrowDown");
    expect(onReorder).not.toHaveBeenCalled();
    await press(item("claude"), "ArrowDown");
    expect(onReorder).toHaveBeenCalledWith(["claude-work", "claude", "laterdogAi"]);
  });

  it("drags an account onto another of its kind, shows it there at once, and hands the order over on the drop", async () => {
    const onReorder = vi.fn();
    await show(onReorder);
    const transfer = new DataTransfer();
    await drag(item("claude-work").parentElement!, "dragstart", transfer);
    await drag(item("laterdogAi").parentElement!, "dragover", transfer);
    expect(order()).toEqual(["claude", "claude-work", "laterdogAi"]);
    await drag(item("claude").parentElement!, "dragover", transfer);
    expect(order()).toEqual(["claude-work", "claude", "laterdogAi"]);
    await drag(item("claude").parentElement!, "drop", transfer);
    await drag(item("claude-work").parentElement!, "dragend", transfer);
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith(["claude-work", "claude", "laterdogAi"]);
  });

  it("offers no grip and no drag when there is nowhere to save the order", async () => {
    await show();
    expect(host.querySelector("[data-account-grip]")).toBeNull();
    expect(host.querySelector("[draggable]")).toBeNull();
  });
});

describe("the message field's model menu", () => {
  const groups = [
    { instance: kimi, label: "Kimi", models: [{ id: "kimi-k2.6", label: "Kimi K2.6" }] },
    { instance: grok, label: "Grok", models: [{ id: "grok-4.3", label: "Grok 4.3" }] },
  ];

  it("lists every model usable now, with no accounts to pick and no effort where there is none", () => {
    const html = renderToStaticMarkup(createElement(ModelMenu, { groups, currentInstanceId: "laterdogAi", currentModel: "kimi-k2.6", onPick: () => {} }));
    expect(html).toContain("Kimi K2.6");
    expect(html).toContain("Grok 4.3");
    expect(html).not.toContain("data-account-row");
    expect(html).not.toContain("data-model-menu-effort");
  });

  it("names each model once, keeping the one in use where two accounts offer the same name", () => {
    const work = instance("claude-work", "claudeAgent", "Work");
    const twins = [
      { instance: claude, label: "Claude", models: [{ id: "opus", label: "Opus 5.5" }, { id: "sonnet", label: "Sonnet 5.5" }] },
      { instance: work, label: "Work", models: [{ id: "opus", label: " opus 5.5" }, { id: "sonnet", label: "Sonnet 5.5" }, { id: "haiku", label: "Haiku 4.5" }] },
    ];
    const routes = (currentInstanceId: string) => distinctModels(twins, currentInstanceId, "sonnet").map((entry) => `${entry.instance.instanceId}/${entry.id}`);
    expect(routes("claude")).toEqual(["claude/opus", "claude/sonnet", "claude-work/haiku"]);
    expect(routes("claude-work")).toEqual(["claude/opus", "claude-work/sonnet", "claude-work/haiku"]);
    const html = renderToStaticMarkup(createElement(ModelMenu, { groups: twins, currentInstanceId: "claude", currentModel: "sonnet", onPick: () => {} }));
    expect(html.match(/opus 5\.5/gi)).toHaveLength(1);
    expect(html.match(/Sonnet 5\.5/g)).toHaveLength(1);
  });

  it("keeps four by name, numbered, and puts the rest under More models", () => {
    const opus = { ...claude, models: { default: "sonnet", options: [] } } as unknown as InstanceInfo;
    const many = [
      { instance: opus, label: "Claude", models: ["opus", "sonnet", "haiku", "fable"].map((id) => ({ id, label: id })) },
      ...groups,
    ];
    const { primary, more } = splitModels(many, "laterdogAi", "kimi-k2.6");
    expect(primary.map((entry) => entry.id)).toEqual(["opus", "sonnet", "kimi-k2.6", "grok-4.3"]);
    expect(more.map((entry) => entry.id)).toEqual(["haiku", "fable"]);
    const html = renderToStaticMarkup(createElement(ModelMenu, { groups: many, currentInstanceId: "laterdogAi", currentModel: "kimi-k2.6", onPick: () => {} }));
    expect(html).toContain("More models");
    expect(html).not.toContain("data-model-menu-effort");
  });
});

describe("the composer's + menu", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("holds attach, connectors and permissions in one place", async () => {
    const onAttach = vi.fn();
    const onConnectors = vi.fn();
    const onSelect = vi.fn();
    await act(async () => root.render(createElement(ComposerPlusMenu, {
      onAttach, onConnectors,
      permissions: { approvalMode: "ask", driverKind: "claudeAgent", trustedModesAvailable: false, disabled: false, onSelect },
    })));
    const plus = host.querySelector<HTMLButtonElement>("[data-composer-plus]")!;
    await act(async () => plus.click());
    expect(host.textContent).toContain("Attach a file");
    expect(host.textContent).toContain("Connect apps");
    expect(host.textContent).toContain("Permissions");
    await act(async () => host.querySelector<HTMLButtonElement>("[data-plus-permission=auto]")!.click());
    expect(onSelect).toHaveBeenCalledWith("auto");
    await act(async () => plus.click());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((item) => item.textContent === "Connect apps")!.click());
    expect(onConnectors).toHaveBeenCalled();
    await act(async () => plus.click());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((item) => item.textContent === "Attach a file")!.click());
    expect(onAttach).toHaveBeenCalled();
  });

  it("offers the dog settings' two levels, plus the one in use if it's another", async () => {
    const levels = async (approvalMode: "ask" | "full") => {
      await act(async () => root.render(createElement(ComposerPlusMenu, {
        onAttach: () => {},
        permissions: { approvalMode, driverKind: "codex", trustedModesAvailable: true, disabled: false, onSelect: () => {} },
      })));
      const plus = host.querySelector<HTMLButtonElement>("[data-composer-plus]")!;
      if (!host.querySelector("[data-composer-plus-menu]")) await act(async () => plus.click());
      const found = [...host.querySelectorAll("[data-plus-permission]")].map((item) => item.getAttribute("data-plus-permission"));
      await act(async () => plus.click());
      return found;
    };
    expect(await levels("ask")).toEqual(["ask", "auto"]);
    expect(await levels("full")).toEqual(["ask", "auto", "full"]);
  });
});
