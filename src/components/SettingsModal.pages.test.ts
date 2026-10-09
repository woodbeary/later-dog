// App Settings has four pages: General, Computer, Usage and Updates. Each
// page's own content has its own tests; here a marker says which ran, and
// what each page shows depends on where the window is (this Mac with the
// desktop bridge, a browser, a paired remote server, a Cloud home).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { AppSettingsSection } from "@/state/store";

const fixture = vi.hoisted(() => ({
  section: "general" as AppSettingsSection,
  config: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  analytics: false,
}));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(),
  useStore: () => ({ state: { appSettingsSection: fixture.section, instances: [], bots: [], config: fixture.config }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/laterdog-analytics", () => ({ analyticsConfigured: () => fixture.analytics }));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => (window.laterdog?.updater ? { status: "idle" } : null) }));
vi.mock("@/lib/app-links", () => ({ appVersion: () => "1.2.3", openExternalLink: vi.fn() }));
vi.mock("../lib/brand", () => ({ brand: () => ({ name: "later.dog" }) }));
const { marker } = vi.hoisted(() => ({ marker: (name: string) => () => `MARKER:${name};` }));
vi.mock("./AccountsPanel", () => ({ AccountsPanel: marker("accounts") }));
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

/** This Mac, in the desktop app: the permission bridge and the updater. */
const MAC = { laterdog: { platform: "darwin", permissions: { status: vi.fn(), request: vi.fn(), openSettings: vi.fn() }, updater: { check: vi.fn(), install: vi.fn(), onState: vi.fn() }, relaunch: vi.fn() } };

beforeEach(() => {
  vi.clearAllMocks();
  fixture.section = "general";
  fixture.config = { features: { browser: false }, browserEngine: { kind: "bundled", installable: true } };
  fixture.analytics = false;
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
    // nothing from before: no search box, no Advanced switch, no old pages
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
  it("stacks Accounts, Appearance and System, in that order", () => {
    const html = render();
    expect(groups(html)).toEqual(["accounts", "appearance", "system"]);
    expect(markers(html)).toEqual(["accounts", "skin", "permissions=microphone"]);
    // the group labels and row titles, each closed by its div (Language's own picker lists "System" too)
    const order = ["Accounts", "Appearance", "Theme", "Language", "Notification sounds", "System", "Your name"].map((word) => html.indexOf(`>${word}</div>`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('aria-label="Your name"');
    // the email and shared context left Settings
    expect(html).not.toContain("Email");
    expect(html).not.toContain("About you");
  });

  it("asks for the microphone only on a Mac with the desktop bridge", () => {
    vi.stubGlobal("window", {});
    expect(markers(render())).toEqual(["accounts", "skin"]);
    vi.stubGlobal("window", { laterdog: { ...MAC.laterdog, platform: "win32" } });
    expect(markers(render())).toEqual(["accounts", "skin"]);
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
    // the Local VM's advanced controls left: no VPS, no alias
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

  it("without the updater, says the version and that updates come with the desktop app", () => {
    vi.stubGlobal("window", {});
    const html = render();
    expect(html).toMatch(/data-app-version[^>]*>1\.2\.3</);
    expect(html).toContain("Updates come with the desktop app.");
    expect(html).not.toContain("Check for updates");
  });
});
