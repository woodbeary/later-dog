// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { BotEditorStore, type ConfigStatus, type InstanceInfo, type useStore } from "@/state/store";
import { SavedApiKeys, savedKeyEngines } from "./SavedApiKeys";

const engine = (instanceId: string, driverKind: string, overrides: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId, driverKind, displayName: instanceId, access: "api",
  snapshot: { state: "available", authenticated: true, version: "1.0.0" },
  models: { default: "", options: [] },
  ...overrides,
});

let host: HTMLDivElement;
let root: Root;
const mount = (instances: InstanceInfo[], config: Partial<ConfigStatus> = {}) => {
  const store = { state: { config }, dispatch: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() } as unknown as ReturnType<typeof useStore>;
  return act(async () => root.render(createElement(BotEditorStore, { value: store, children: createElement(SavedApiKeys, { instances }) })));
};
const rows = () => [...host.querySelectorAll<HTMLElement>("[data-saved-api-key]")].map((row) => row.dataset.savedApiKey);
const button = (id: string) => host.querySelector<HTMLButtonElement>(`[data-saved-api-key="${id}"] button[aria-expanded]`)!;
const card = (id: string) => host.querySelector(`[data-saved-api-key="${id}"] [data-engine-setup-api-key="configured"]`);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("laterdog", { platform: "darwin", remoteClient: { active: false } });
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("saved API keys", () => {
  it("lists each saved key once, and leaves out sign-ins, missing keys and keys an organisation manages", () => {
    const listed = savedKeyEngines([
      engine("claude", "claudeAgent", { access: "subscription" }),
      engine("openai", "openai-compat"),
      engine("openrouter", "openai-compat", { snapshot: { state: "unavailable", authenticated: false } }),
      engine("mistral", "mistral", { managed: { organizationId: "org", organizationName: "Acme" } }),
      engine("proxy", "openai-compat"),
      engine("proxy-two", "openai-compat"),
      engine("xai", "grok"),
    ]);
    expect(listed.map((instance) => instance.instanceId)).toEqual(["openai", "proxy", "xai"]);
  });

  it("opens one key's own card at a time, to replace or clear that key", async () => {
    await mount([engine("openai", "openai-compat", { displayName: "OpenAI" }), engine("xai", "grok", { displayName: "Grok (API)" })]);
    expect(rows()).toEqual(["openai", "xai"]);
    expect(host.textContent).toContain("Runs on your API key, billed per token by the provider.");
    expect(button("openai").textContent).toBe("Change key");
    expect(host.querySelector("[data-engine-setup-api-key]")).toBeNull();

    await act(async () => button("openai").click());
    expect(button("openai").getAttribute("aria-expanded")).toBe("true");
    expect(card("openai")?.textContent).toContain("OpenAI uses your API key");
    expect(card("openai")?.textContent).toContain("To fix a typo or use a new key, paste it below, or clear it.");
    expect(card("openai")?.querySelector('[data-engine-setup-key-field="openai"]')).not.toBeNull();

    await act(async () => button("xai").click());
    expect(card("openai")).toBeNull();
    expect(card("xai")?.querySelector('[data-engine-setup-key-field="xai"]')).not.toBeNull();

    await act(async () => button("xai").click());
    expect(host.querySelector("[data-engine-setup-api-key]")).toBeNull();
  });

  it("keeps the switch that puts every Claude dog on the Anthropic key beside that key", async () => {
    await mount([engine("claudeApi", "claudeAgent", { displayName: "Claude (API key)" })], { anthropic: { configured: true, everyClaudeBot: true } });
    await act(async () => button("claudeApi").click());
    const every = card("claudeApi")?.querySelector<HTMLInputElement>("[data-anthropic-every-claude-bot] input[type=checkbox]");
    expect(every?.checked).toBe(true);
    expect(card("claudeApi")?.textContent).toContain("Use this key for every Claude dog");
  });

  it("from a paired phone or browser, says where the key can be changed instead of offering the field", async () => {
    vi.stubGlobal("laterdog", { platform: "darwin", remoteClient: { active: true } });
    await mount([engine("openai", "openai-compat", { displayName: "OpenAI" })]);
    await act(async () => button("openai").click());
    expect(card("openai")?.textContent).toContain("To change the key, open Settings on the computer running later.dog.");
    expect(card("openai")?.querySelector("[data-engine-setup-key-field]")).toBeNull();
  });
});
