import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { AppSettingsSection, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  section: "general" as AppSettingsSection,
  config: {} as Record<string, unknown>,
  instances: [] as InstanceInfo[],
  dispatch: vi.fn(),
  analytics: false,
  updater: { status: "idle" } as Record<string, unknown>,
}));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(),
  useStore: () => ({ state: { appSettingsSection: fixture.section, instances: fixture.instances, bots: [], config: fixture.config }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/laterdog-analytics", () => ({ analyticsConfigured: () => fixture.analytics }));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => (window.laterdog?.updater ? fixture.updater : null) }));
vi.mock("@/lib/app-links", () => ({ appVersion: () => "1.2.3", openExternalLink: vi.fn() }));
vi.mock("../lib/brand", () => ({ brand: () => ({ name: "later.dog" }) }));
const { marker } = vi.hoisted(() => ({ marker: (name: string) => () => `MARKER:${name};` }));
vi.mock("./AccountsPanel", () => ({ AccountsPanel: marker("accounts") }));
vi.mock("./AboutMeSettings", () => ({ AboutMeSettings: marker("about-me") }));
vi.mock("./SavedApiKeys", async (importOriginal) => ({
  ...await importOriginal<typeof import("./SavedApiKeys")>(),
  SavedApiKeys: ({ instances }: { instances: readonly InstanceInfo[] }) => `MARKER:api-keys=${instances.map((instance) => instance.instanceId).join("+")};`,
}));
vi.mock("./UsageSection", () => ({ UsageSection: marker("usage") }));
vi.mock("./LocalVmRows", () => ({ LocalVmRows: marker("local-vm") }));
vi.mock("./CloudComputerRows", () => ({ CloudComputerRows: marker("cloud-computers") }));
vi.mock("./SkinPicker", () => ({ SkinPicker: marker("skin") }));
vi.mock("./PermissionChecklist", () => ({
  PermissionChecklist: ({ permissions }: { permissions: readonly string[] }) => `MARKER:permissions=${permissions.join("+")};`,
}));
vi.mock("@/lib/use-desktop-permissions", () => ({
  useDesktopPermissions: () => ({ checklist: null, busy: null, request: vi.fn(), openSettings: vi.fn(), refresh: vi.fn() }),
}));

import { SETTINGS_PAGES, SettingsModal } from "./SettingsModal";

const MAC = { laterdog: { platform: "darwin", permissions: { status: vi.fn(), request: vi.fn(), openSettings: vi.fn() }, updater: { check: vi.fn(), install: vi.fn(), onState: vi.fn() }, relaunch: vi.fn() } };

beforeEach(() => {
  vi.clearAllMocks();
  fixture.section = "general";
  fixture.config = { features: { browser: false }, browserEngine: { kind: "bundled", installable: true } };
  fixture.instances = [];
  fixture.analytics = false;
  fixture.updater = { status: "idle" };
  vi.stubGlobal("window", MAC);
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

const render = () => renderToStaticMarkup(createElement(SettingsModal));
const pages = (html: string) => [...html.matchAll(/data-settings-page="([^"]+)"/g)].map((match) => match[1]);
const currentPage = (html: string) => html.match(/data-settings-page="([^"]+)" aria-current="page"/)?.[1];
const groups = (html: string) => [...html.matchAll(/data-settings-group="([^"]+)"/g)].map((match) => match[1]);
const markers = (html: string) => [...html.matchAll(/MARKER:([^;]+);/g)].map((match) => match[1]);

describe("the Settings rail", () => {
  it("lists the four pages, with icons, and the same four in the narrow-window picker", () => {
    const html = render();
    expect(SETTINGS_PAGES.map((page) => page.id)).toEqual(["general", "computer", "usage", "updates"]);
    expect(pages(html)).toEqual(["general", "computer", "usage", "updates"]);
    expect(currentPage(html)).toBe("general");
    for (const page of pages(html)) expect(html).toMatch(new RegExp(`data-settings-page="${page}"[^>]*>\\s*<svg`));
    const picker = html.match(/<select aria-label="Settings"[\s\S]*?<\/select>/)![0];
    expect([...picker.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1])).toEqual(["general", "computer", "usage", "updates"]);
    expect(picker).toContain(">General<");
    expect(picker).toContain(">Computer<");
    expect(picker).toContain(">Usage<");
    expect(picker).toContain(">Updates<");
    expect(html).not.toContain("data-settings-search");
    expect(html).not.toContain("Advanced mode");
    for (const gone of ["engines", "connections", "companion", "organization", "experimental", "appearance"]) expect(html).not.toContain(`data-settings-page="${gone}"`);
  });

  it("keeps the dialog's title, close button and glass frame", () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-labelledby="app-settings-title"');
    expect(html).toContain('aria-label="Close settings"');
    expect(html).toContain('class="glass-popup-frame"');
  });

  it("lands on General for a page it no longer has", () => {
    fixture.section = "engines" as AppSettingsSection;
    expect(currentPage(render())).toBe("general");
    expect(markers(render())).toContain("accounts");
  });
});

describe("General", () => {
  it("stacks Accounts, Profile, Appearance and System, in that order", () => {
    const html = render();
    expect(groups(html)).toEqual(["accounts", "profile", "appearance", "system"]);
    expect(markers(html)).toEqual(["accounts", "about-me", "skin", "permissions=microphone"]);
    const order = ["Accounts", "Profile", "Your name", "Appearance", "Theme", "Language", "Notification sounds", "System"].map((word) => html.indexOf(`>${word}</div>`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('aria-label="Your name"');
    expect(html).not.toContain("Email");
  });

  it("lists the saved API keys under Accounts, only once a key is saved", () => {
    const models = { default: "", options: [] };
    fixture.instances = [
      { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription", snapshot: { state: "available", authenticated: true, version: "2.0.0" }, models },
      { instanceId: "openai", driverKind: "openai-compat", displayName: "OpenAI", access: "api", snapshot: { state: "available", authenticated: true }, models },
      { instanceId: "mistral", driverKind: "mistral", displayName: "Mistral", access: "api", snapshot: { state: "unavailable", authenticated: false }, models },
    ];
    const html = render();
    expect(groups(html)).toEqual(["accounts", "api-keys", "profile", "appearance", "system"]);
    expect(markers(html)).toEqual(["accounts", "api-keys=openai", "about-me", "skin", "permissions=microphone"]);
    expect(html).toContain(">API keys</div>");
  });

  it("asks for the microphone only on a Mac with the desktop bridge", () => {
    vi.stubGlobal("window", {});
    expect(markers(render())).toEqual(["accounts", "about-me", "skin"]);
    vi.stubGlobal("window", { laterdog: { ...MAC.laterdog, platform: "win32" } });
    expect(markers(render())).toEqual(["accounts", "about-me", "skin"]);
  });

  it("leaves System out where it would be empty", () => {
    vi.stubGlobal("window", {});
    expect(groups(render())).toEqual(["accounts", "profile", "appearance"]);
    fixture.analytics = true;
    expect(groups(render())).toEqual(["accounts", "profile", "appearance", "system"]);
  });

  it("has the analytics switch only where an analytics key is built in", () => {
    expect(render()).not.toContain("Usage analytics");
    fixture.analytics = true;
    const html = render();
    expect(html).toContain("Usage analytics");
    expect(html).toMatch(/aria-label="Send usage analytics"[^>]*role="switch"/);
  });
});

describe("Computer", () => {
  beforeEach(() => { fixture.section = "computer"; });

  it("shows this Mac's computer-control permissions, the Local VM, cloud computers and the built-in browser", () => {
    const html = render();
    expect(currentPage(html)).toBe("computer");
    expect(groups(html)).toEqual(["this-mac", "local-vm", "cloud-computers", "browser"]);
    expect(markers(html)).toEqual(["permissions=accessibility+screen", "local-vm", "cloud-computers"]);
    expect(html).toContain("What macOS lets later.dog do on this Mac.");
    expect(html).toContain("data-built-in-browser");
    expect(html).toMatch(/aria-label="Enable the built-in browser"[^>]*role="switch" aria-checked="false"/);
    for (const gone of ["VPS", "alias"]) expect(html).not.toContain(gone);
  });

  it("has no Mac group in a browser or on another platform, and no Local VM on a Cloud home", () => {
    vi.stubGlobal("window", {});
    expect(groups(render())).toEqual(["local-vm", "cloud-computers", "browser"]);
    vi.stubGlobal("window", { laterdog: { ...MAC.laterdog, platform: "linux" } });
    expect(groups(render())).toEqual(["local-vm", "cloud-computers", "browser"]);
    fixture.config = { ...fixture.config, cloudHome: true };
    vi.stubGlobal("window", MAC);
    expect(groups(render())).toEqual(["this-mac", "cloud-computers", "browser"]);
  });

  it("shows nothing of the server's computer from a paired remote client", () => {
    vi.stubGlobal("window", { laterdog: { ...MAC.laterdog, remoteClient: { active: true } } });
    const html = render();
    expect(groups(html)).toEqual([]);
    expect(markers(html)).toEqual([]);
  });
});

describe("Usage", () => {
  it("is the usage section, nothing else", () => {
    fixture.section = "usage";
    const html = render();
    expect(currentPage(html)).toBe("usage");
    expect(markers(html)).toEqual(["usage"]);
    expect(groups(html)).toEqual([]);
  });
});

describe("Updates", () => {
  beforeEach(() => { fixture.section = "updates"; });

  it("names the running version and offers Check for updates in the desktop app", () => {
    const html = render();
    expect(currentPage(html)).toBe("updates");
    expect(html).toMatch(/data-app-version[^>]*>1\.2\.3</);
    expect(html).toMatch(/<button[^>]*>Check for updates<\/button>/);
    expect(html).not.toContain("Updates come with the desktop app.");
  });

  it("keeps the switch that turns checking for new versions back on once it is off", () => {
    fixture.updater = { status: "idle", releaseCheck: "off" };
    vi.stubGlobal("window", { laterdog: { ...MAC.laterdog, releaseCheck: { setEnabled: vi.fn() } } });
    const html = render();
    expect(html).toContain("Checking for new versions is off.");
    expect(html).toContain("Check for new versions");
    expect(html).toMatch(/role="switch" aria-checked="false"/);
  });

  it("without the updater, says the version and that updates come with the desktop app", () => {
    vi.stubGlobal("window", {});
    const html = render();
    expect(html).toMatch(/data-app-version[^>]*>1\.2\.3</);
    expect(html).toContain("Updates come with the desktop app.");
    expect(html).not.toContain("Check for updates");
  });
});
