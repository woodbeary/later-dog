import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { setLocale } from "@/lib/i18n";

vi.hoisted(() => vi.stubGlobal("window", {}));

const { keyProviders, MoreProviders } = await import("./AddAccountProviders");

const api = (instanceId: string, driverKind: string, displayName: string, icon?: InstanceInfo["icon"]): InstanceInfo => ({
  instanceId, driverKind, displayName, access: "api", ...(icon ? { icon } : {}),
  snapshot: { state: "available", version: "1.0.0", authenticated: false },
  models: { default: "", options: [] },
});

const SERVER_FLEET: InstanceInfo[] = [
  api("openai", "openai-compat", "OpenAI", { kind: "preset", preset: "openai" }),
  api("claudeApi", "claudeAgent", "Claude (API key)", { kind: "preset", preset: "anthropic" }),
  api("xaiApi", "grok", "xAI", { kind: "preset", preset: "xai" }),
  api("openrouter", "openai-compat", "OpenRouter", { kind: "preset", preset: "openrouter" }),
  api("mistral", "mistral", "Mistral"),
  api("cerebras", "cerebras", "Cerebras"),
  api("lmstudio", "openai-compat", "My server"),
];

describe("the Add account sheet's other providers", () => {
  it("lists every key provider in order, each with its own mark rather than a letter", () => {
    setLocale("en");
    const providers = keyProviders(SERVER_FLEET);
    expect(providers.map((instance) => instance.instanceId)).toEqual(["openrouter", "xaiApi", "openai", "claudeApi", "mistral", "cerebras", "lmstudio"]);
    const html = renderToStaticMarkup(createElement(MoreProviders, { providers, onPick: () => {} }));
    const rows = html.split("data-key-provider=").slice(1);
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row).toMatch(/<svg|<img/);
      expect(row).not.toContain("data-letter-mark");
    }
  });
});
