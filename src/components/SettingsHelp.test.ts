// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), openExternalLink: vi.fn(async () => true) }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(() => new Promise(() => {})),
  useStore: () => ({ state: { appSettingsSection: "general", instances: [], bots: [], config: { features: {} } }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/app-links", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/app-links")>(),
  appVersion: () => "1.2.3",
  openExternalLink: fixture.openExternalLink,
}));
vi.mock("./AccountsPanel", () => ({ AccountsPanel: () => null, AccountsRefresh: () => null }));
vi.mock("./AboutMeSettings", () => ({ AboutMeSettings: () => null }));
vi.mock("./ReleaseCheck", async (importOriginal) => ({ ...await importOriginal<typeof import("./ReleaseCheck")>(), AboutReleaseLine: () => null }));

const { HelpRows } = await import("./SettingsHelp");
const { SettingsModal } = await import("./SettingsModal");
const { FEEDBACK_URL, HELP_CENTER_URL } = await import("@/lib/app-links");

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.dispatch.mockReset();
  fixture.openExternalLink.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const help = (name: string) => document.querySelector<HTMLButtonElement>(`[data-settings-help="${name}"]`)!;
const about = () => document.querySelector('[aria-labelledby="about-dialog-title"]');
const escape = () => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })); });

describe("Help in Settings", () => {
  it("closes Settings before showing the keyboard shortcuts, and opens help and feedback outside", async () => {
    await act(async () => root.render(createElement(HelpRows)));
    await act(async () => help("shortcuts").click());
    expect(fixture.dispatch.mock.calls).toEqual([[{ type: "toggleAppSettings", open: false }], [{ type: "toggleShortcuts", open: true }]]);
    await act(async () => help("help").click());
    await act(async () => help("feedback").click());
    expect(fixture.openExternalLink.mock.calls).toEqual([[HELP_CENTER_URL], [FEEDBACK_URL]]);
  });

  it("opens About over Settings, and Escape closes only About", async () => {
    await act(async () => root.render(createElement(SettingsModal)));
    await act(async () => help("about").click());
    expect(about()?.querySelector("h2")?.textContent).toBe("later.dog");
    await escape();
    expect(about()).toBeNull();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    await escape();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: false });
  });
});
