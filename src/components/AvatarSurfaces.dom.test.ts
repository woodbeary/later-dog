// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), flush: vi.fn(async () => null) }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: { config: { imageGen: { configured: false } }, botCreationPending: false }, dispatch: fixture.dispatch, flushBotPatches: fixture.flush }) }));
vi.mock("./VoiceSettings", () => ({ VoiceSettings: () => null }));
vi.mock("./DesktopCapabilities", () => ({ useCaptionChrome: () => ({}) }));
vi.mock("./Avatar", () => ({ BotAvatar: () => createElement("span", { "data-bot-avatar": "" }) }));
import { RemoteAgentSettingsPanel } from "./RemoteAgentSettingsPanel";
import { NewBotDialog } from "./NewBotDialog";

let host: HTMLDivElement;
let root: Root;
const bot = { id: "remote-dog", name: "Scout", title: "Researcher", description: "", notifications: true } as Bot;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.api.mockReset();
  fixture.api.mockReturnValue(new Promise(() => {}));
  fixture.dispatch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("picture editing on every dog surface", () => {
  it.each(["new dog", "remote agent"])("offers Generate and secure setup in %s", (surface) => {
    act(() => root.render(surface === "new dog" ? createElement(NewBotDialog) : createElement(RemoteAgentSettingsPanel, { bot })));
    act(() => host.querySelector<HTMLButtonElement>("[data-avatar-edit]")!.click());
    const generate = host.querySelector<HTMLButtonElement>('[data-avatar-option="generate"]')!;
    expect(generate).not.toBeNull();
    expect(generate.disabled).toBe(false);
    act(() => generate.click());
    expect(host.querySelector("[data-image-generation-setup]")).not.toBeNull();
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
  });
});
