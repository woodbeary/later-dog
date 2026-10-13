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

  it("leads with the newest of each family and keeps earlier versions under More models", () => {
    const anthropic = { ...claude, models: { default: "claude-sonnet-5", options: [] } } as unknown as InstanceInfo;
    const codex = instance("codex", "codex", "Codex");
    const live = [
      {
        instance: anthropic,
        label: "Claude",
        models: [
          ["claude-fable-5-1", "Claude Fable 5.1"], ["claude-fable-5", "Claude Fable 5"],
          ["claude-opus-5-5", "Claude Opus 5.5"], ["claude-opus-5", "Claude Opus 5"],
          ["claude-sonnet-5-5", "Claude Sonnet 5.5"], ["claude-sonnet-5", "Claude Sonnet 5"],
          ["claude-haiku-5-5", "Claude Haiku 5.5"], ["claude-haiku-4-5", "Claude Haiku 4.5"],
        ].map(([id, label]) => ({ id, label })),
      },
      {
        instance: codex,
        label: "Codex",
        models: [["gpt-6-astra", "GPT-6-Astra"], ["gpt-5.6-sol", "GPT-5.6-Sol"], ["gpt-5.6-terra", "GPT-5.6-Terra"], ["daybreak", "Daybreak Blue"]]
          .map(([id, label]) => ({ id, label })),
      },
    ];
    const ids = (entries: readonly { id: string }[]) => entries.map((entry) => entry.id);
    const opus = splitModels(live, "claude", "claude-opus-5-5");
    expect(ids(opus.primary)).toEqual(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "gpt-6-astra", "daybreak"]);
    expect(ids(opus.more)).toEqual([]);
    expect(ids(opus.earlier)).toEqual(["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "gpt-5.6-sol", "gpt-5.6-terra"]);
    const older = splitModels(live, "claude", "claude-sonnet-5");
    expect(ids(older.primary)).toEqual(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-5-5", "gpt-6-astra", "daybreak"]);
    expect(ids(older.earlier)).not.toContain("claude-sonnet-5");
  });

  it("keeps eight by name, numbered, and puts the rest under More models above the earlier versions", async () => {
    const many = [
      { instance: claude, label: "Claude", models: ["opus", "sonnet", "haiku", "fable", "mythos", "Claude 5", "Claude 4"].map((id) => ({ id, label: id })) },
      ...groups,
    ];
    const { primary, more, earlier } = splitModels(many, "laterdogAi", "kimi-k2.6");
    expect(primary.map((entry) => entry.id)).toEqual(["opus", "sonnet", "haiku", "fable", "mythos", "Claude 5", "kimi-k2.6", "grok-4.3"]);
    expect(more).toEqual([]);
    expect(earlier.map((entry) => entry.id)).toEqual(["Claude 4"]);
    const crowded = [{ instance: claude, label: "Claude", models: "abcdefghij".split("").map((id) => ({ id, label: `Model ${id}` })) }];
    const split = splitModels(crowded, "claude", "j");
    expect(split.primary.map((entry) => entry.id)).toEqual(["a", "b", "c", "d", "e", "f", "g", "j"]);
    expect(split.more.map((entry) => entry.id)).toEqual(["h", "i"]);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => root.render(createElement(ModelMenu, { groups: many, currentInstanceId: "laterdogAi", currentModel: "kimi-k2.6", onPick: () => {} })));
    expect(host.textContent).toContain("More models");
    expect(host.querySelector("[data-model-menu-effort]")).toBeNull();
    await act(async () => (host.querySelector("[data-model-more]") as HTMLButtonElement).click());
    const list = host.querySelector("[data-model-more-list]")!;
    expect(list.querySelector("[data-model-earlier]")?.textContent).toBe("Earlier versions");
    expect([...list.querySelectorAll("[data-model-option]")].map((node) => node.textContent)).toEqual(["Claude 4"]);
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
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
