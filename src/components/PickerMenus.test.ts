// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { setLocale } from "@/lib/i18n";
import { AccountMenu } from "./AccountMenu";
import { ComposerPlusMenu } from "./ComposerPlusMenu";
import { ModelMenu, splitModels } from "./ModelMenu";

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
});
