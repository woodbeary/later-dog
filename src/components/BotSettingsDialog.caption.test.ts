import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => false }));
vi.mock("./bot-settings/useBotSettingsDerived", () => ({ useBotSettingsDerived: () => ({ botRoutines: [] }) }));
vi.mock("./bot-settings/SkillsSection", () => ({
  useManagedSkills: () => ({ skills: [], loading: false, working: "", error: "", reviewing: null, libraryPool: [], addFromLibrary: "" }),
  SkillReviewDialog: () => null,
}));
vi.mock("./bot-settings/MemorySection", () => ({ MemorySection: () => null }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("./SoulField", () => ({ SoulField: () => null }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null, DogAvatar: () => null }));
vi.mock("@/state/store", async (importOriginal) => {
  const store = await importOriginal<typeof import("@/state/store")>();
  return { ...store, useStore: () => ({ state: store.initialState, dispatch: vi.fn(), flushBotPatches: vi.fn() }) };
});
import { BotSettingsDialog } from "./BotSettingsDialog";
import { DesktopCapabilitiesProvider } from "./DesktopCapabilities";

const bot = { id: "bot-1", name: "Maily", title: "", color: "green", messages: [] } as never as Bot;
// The provider reads window.laterdog.platform on render, so each case sees its stub.
const header = () => {
  const html = renderToStaticMarkup(createElement(DesktopCapabilitiesProvider, null, createElement(BotSettingsDialog, { bot })));
  return html.match(/<div class="([^"]*)"><span id="bot-settings-title"/)?.[1] ?? "";
};

afterEach(() => vi.unstubAllGlobals());

describe("bot settings caption inset", () => {
  it("drops the close button below the Windows caption buttons", () => {
    vi.stubGlobal("window", { laterdog: { platform: "win32" } });
    expect(header()).toContain("pt-[28px]");
  });

  it("keeps the header flush elsewhere", () => {
    vi.stubGlobal("window", { laterdog: { platform: "darwin" } });
    const classes = header();
    expect(classes).toContain("py-3");
    expect(classes).not.toContain("pt-[28px]");
  });
});
