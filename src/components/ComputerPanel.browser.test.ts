import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import type { FeatureFlagConfig } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("localStorage", { getItem: () => null });
  return { config: {} as FeatureFlagConfig & { cloudHome?: boolean } };
});
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({
    state: { config: { box: { configured: false }, ...fixture.config }, instances: [], computerControl: {}, routines: [], routineRuns: [] },
    dispatch: vi.fn(),
    flushBotPatches: vi.fn(),
  }),
}));
import { ComputerPanel } from "./ComputerPanel";

afterAll(() => vi.unstubAllGlobals());
const bot = { id: "panel-fixture", name: "Panel fixture", computer: "local", modelSelection: { instanceId: "fixture" } } as Bot;
const render = (config: FeatureFlagConfig & { cloudHome?: boolean }) => {
  fixture.config = config;
  return renderToStaticMarkup(createElement(ComputerPanel, { bot }));
};

describe("Computer panel on a narrow screen", () => {
  it("covers the window below md instead of docking a 400px column", () => {
    // A phone reaches this panel through the browser (remote access). Docked
    // at its stored width it pushed the chat to zero and ran off the right
    // edge, where `body { overflow: hidden }` cut it off. Below md it takes
    // the window like the settings and inspector panels do; the inline width
    // still sizes it beside the chat on wider screens.
    const markup = render({});
    const aside = /<aside class="([^"]*)"/.exec(markup)!;
    expect(aside[1].split(" ")).toEqual(expect.arrayContaining(["max-md:absolute", "max-md:inset-0", "max-md:z-40", "max-md:w-full!"]));
    // Nothing to drag against when the panel is the whole window.
    const separator = /<div role="separator"[^>]*class="([^"]*)"/.exec(markup)!;
    expect(separator[1].split(" ")).toContain("max-md:hidden");
  });
});

describe("Computer panel header", () => {
  it("names its icon-only close button", () => {
    expect(render({})).toContain(`aria-label="${t("computer.close")}"`);
  });
});
