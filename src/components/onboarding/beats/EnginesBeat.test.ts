import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = { current: initial };
    return fixture.values[index];
  },
  useEffect: (effect: EffectCallback) => {
    fixture.effects.push(effect);
  },
}));
const store = vi.hoisted(() => ({ instances: [] as unknown[], dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: store.api, useStore: () => ({ state: { instances: store.instances }, dispatch: store.dispatch }) }));
import { EnginesBeat } from "./EnginesBeat";

const engine = (instanceId: string, driverKind: string, ready: boolean, displayName = instanceId, extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId, driverKind, displayName, install: { docsUrl: "https://example.test" },
  snapshot: { state: ready ? "available" : "unavailable", authenticated: ready },
  models: { default: "m", options: [] },
  ...extra,
});
const props = { onNext: vi.fn(), onSkip: vi.fn(), setMascot: vi.fn(), bump: vi.fn() };

function render() {
  fixture.index = 0;
  fixture.effects = [];
  return renderToStaticMarkup(createElement(() => EnginesBeat(props)));
}
/** The visible row names, in order. */
const rows = (html: string) => [...html.matchAll(/<span class="truncate text-\[14px\] font-medium text-ink">([^<]+)<\/span>/g)].map((m) => m[1]);

beforeEach(() => {
  fixture.values = [];
  store.dispatch.mockReset();
  store.instances = [
    engine("grok", "grokAgent", false, "Grok"),
    engine("cursor", "cursorAgent", false, "Cursor"),
    engine("claude", "claudeAgent", true, "Claude Code"),
    engine("codex", "codex", false, "Codex"),
    engine("chatgpt", "codex", false, "ChatGPT plan"),
    engine("openaiCompat", "openai-compat", false, "OpenAI-compatible", { access: "custom" }),
    engine("kimi", "kimiAgent", false, "Kimi"),
  ];
  vi.stubGlobal("window", {});
  setLocale("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the providers step of first run", () => {
  it("leads with Claude, Codex, Cursor and OpenAI-compatible, in that order, each once", () => {
    expect(rows(render())).toEqual(["Claude", "Codex", "Cursor", "OpenAI-compatible"]);
  });

  it("shows Codex once and ready when either of its routes is signed in", () => {
    store.instances = store.instances.map((instance) => ((instance as InstanceInfo).instanceId === "chatgpt" ? engine("chatgpt", "codex", true, "ChatGPT plan") : instance));
    const html = render();
    expect(rows(html).filter((name) => name === "Codex")).toHaveLength(1);
    expect(html).not.toContain("ChatGPT plan");
    const codex = html.slice(html.indexOf(">Codex<"), html.indexOf(">Cursor<"));
    expect(codex).toContain("Ready");
  });

  it("names engines that are not set up as coming soon, and lists one that already works", () => {
    let html = render();
    expect(html).toContain("Coming soon: Grok, Kimi");
    expect(rows(html)).not.toContain("Grok");
    store.instances = store.instances.map((instance) => ((instance as InstanceInfo).instanceId === "grok" ? engine("grok", "grokAgent", true, "Grok") : instance));
    fixture.values = [];
    html = render();
    expect(rows(html)).toEqual(["Claude", "Codex", "Cursor", "OpenAI-compatible", "Grok"]);
    expect(html).toContain("Coming soon: Kimi");
  });

  it("offers no organisation row and no product the build has no engine for", () => {
    store.instances = [engine("claude", "claudeAgent", false, "Claude Code")];
    const html = render();
    expect(rows(html)).toEqual(["Claude"]);
    expect(html).not.toContain("at work");
  });

  it("checks again from an icon with a name, not a word beside it", () => {
    const html = render();
    expect(html).toMatch(/<button type="button" aria-label="Check again" title="Check again"/);
    expect(html).not.toContain(">Check again<");
  });

  it("looks proud once anything can run, curious while nothing can", () => {
    render();
    for (const effect of fixture.effects) effect();
    expect(props.setMascot).toHaveBeenLastCalledWith("proud");
    store.instances = [engine("claude", "claudeAgent", false)];
    fixture.values = [];
    render();
    for (const effect of fixture.effects) effect();
    expect(props.setMascot).toHaveBeenLastCalledWith("curious");
  });
});
