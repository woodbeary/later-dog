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
vi.mock("@/lib/app-links", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/app-links")>(), appVersion: () => "1.2.3", openExternalLink: vi.fn() }));
vi.mock("../lib/brand", () => ({ brand: () => ({ name: "later.dog" }) }));
const { marker } = vi.hoisted(() => ({ marker: (name: string) => () => `MARKER:${name};` }));
vi.mock("./AccountsPanel", () => ({ AccountsPanel: marker("accounts"), AccountsRefresh: () => createElement("button", { "aria-label": "Refresh accounts" }) }));
vi.mock("./AboutMeSettings", () => ({ AboutMeSettings: marker("about-me") }));
vi.mock("./SavedApiKeys", async (importOriginal) => ({
  ...await importOriginal<typeof import("./SavedApiKeys")>(),
  SavedApiKeys: ({ instances }: { instances: readonly InstanceInfo[] }) => `MARKER:api-keys=${instances.map((instance) => instance.instanceId).join("+")};`,
}));
vi.mock("./UsageSection", () => ({ UsageSection: marker("usage") }));
vi.mock("./CloudComputerRows", () => ({ CloudComputerRows: marker("cloud-computers") }));
vi.mock("./CloudLending", () => ({ CloudLending: marker("lending") }));
vi.mock("./PermissionChecklist", () => ({
  PermissionChecklist: ({ permissions }: { permissions: readonly string[] }) => `MARKER:permissions=${permissions.join("+")};`,
}));
vi.mock("@/lib/use-desktop-permissions", () => ({
  useDesktopPermissions: () => ({ checklist: null, busy: null, request: vi.fn(), openSettings: vi.fn(), refresh: vi.fn() }),
}));

import { SETTINGS_PAGES, SettingsModal } from "./SettingsModal";

const MAC = { laterdog: {
  platform: "darwin",
  permissions: { status: vi.fn(), request: vi.fn(), openSettings: vi.fn() },
  updater: { check: vi.fn(), install: vi.fn(), onState: vi.fn() },
  relaunch: vi.fn(),
  cloudAccount: { state: vi.fn(() => new Promise<never>(() => {})), onState: vi.fn(() => () => {}) },
} };

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
  it("lists the five settings pages, with icons, and the same five in the narrow-window picker", () => {
    const html = render();
    expect(SETTINGS_PAGES.map((page) => page.id)).toEqual(["general", "computer", "vault", "usage", "updates"]);
    expect(pages(html)).toEqual(["general", "computer", "vault", "usage", "updates"]);
    expect(currentPage(html)).toBe("general");
    for (const page of pages(html)) expect(html).toMatch(new RegExp(`data-settings-page="${page}"[^>]*>\\s*<svg`));
    const picker = html.match(/<select aria-label="Settings"[\s\S]*?<\/select>/)![0];
    expect([...picker.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1])).toEqual(["general", "computer", "vault", "usage", "updates"]);
    expect(picker).toContain(">General<");
    expect(picker).toContain(">Computer<");
    expect(picker).toContain(">Vault<");
    expect(picker).toContain(">Usage &amp; Billing<");
    expect(picker).toContain(">Updates<");
    expect(html).not.toContain("data-settings-search");
    expect(html).not.toContain("Advanced mode");
    expect(picker).not.toContain(">Models<");
    for (const gone of ["models", "engines", "connections", "companion", "organization", "experimental", "appearance"]) expect(html).not.toContain(`data-settings-page="${gone}"`);
  });

  it("keeps the dialog's title, close button and glass frame", () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-labelledby="app-settings-title"');
    expect(html).toContain('aria-label="Close settings"');
    expect(html).toContain('class="glass-popup-frame"');
  });

  it("lands on General for a page it no longer has", () => {
    for (const gone of ["engines", "models"]) {
      fixture.section = gone as AppSettingsSection;
      expect(currentPage(render())).toBe("general");
      expect(markers(render())).toContain("accounts");
    }
  });
});

describe("General", () => {
  it("has no server access or workspace recovery disclosure, even with saved workspaces", () => {
    vi.stubGlobal("window", { laterdog: { ...MAC.laterdog, workspaces: { state: vi.fn(), menu: vi.fn() } } });
    const html = render();
    expect(html).not.toContain("data-server-access");
    expect(html).not.toContain("data-workspace-recovery");
    expect(html).not.toContain("data-phone-pairing");
  });

  it("stacks later.dog Cloud, AI accounts, Profile, Dogs, Appearance, System and Help, in that order", () => {
    const html = render();
    expect(groups(html)).toEqual(["later-dog-cloud", "accounts", "profile", "dogs", "appearance", "system", "help"]);
    expect(markers(html)).toEqual(["accounts", "about-me", "permissions=microphone"]);
    const order = ["later.dog Cloud", "AI accounts", "Profile", "Your name", "Dogs", "Auto-review", "Appearance", "Theme", "Language", "Notification sounds", "System", "Help"].map((word) => html.indexOf(`>${word}</div>`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('aria-label="Your name"');
    expect(html).not.toContain("Email");
  });

  it("has none of the extra rows: no Voice mode, Step-by-step updates, Show every update, Typing suggestions or Sharper dictation", () => {
    fixture.config = { ...fixture.config, features: { browser: false, showToolCalls: true, cloudDictation: true, typingSuggestions: true } };
    const html = render();
    for (const gone of ["Voice mode", "Step-by-step updates", "Show every update", "Typing suggestions", "Smarter suggestions", "Sharper dictation"]) expect(html).not.toContain(gone);
    expect(html).not.toContain('data-settings-group="typing-suggestions"');
    expect(html.match(/role="switch"/g) ?? []).toHaveLength(3);
    expect(html).toContain('data-auto-review="on"');
    expect(html).toContain('data-call-button="on"');
  });

  it("shows the call button by default and lets you hide it", () => {
    const on = render();
    expect(on).toContain('aria-label="Call button"');
    expect(on).toContain('data-call-button="on"');
    fixture.config = { ...fixture.config, features: { browser: false, callButton: false } };
    expect(render()).toContain('data-call-button="off"');
  });

  it("puts the one Auto-review switch under Dogs, saying what on and off mean", () => {
    const on = render();
    expect(on).toContain('aria-label="Auto-review"');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain("An AI reviewer checks each step first. You&#x27;re asked only when it isn&#x27;t sure.");
    fixture.config = { ...fixture.config, features: { browser: false, autoReview: false } };
    const off = render();
    expect(off).toContain('data-auto-review="off"');
    expect(off).toContain("Dogs act without asking you first. A few risky steps are always refused.");
    for (const gone of ["Heel", "Off-leash"]) expect(off).not.toContain(gone);
  });

  it("picks the theme from System, Light and Dark", () => {
    const select = render().match(/<select[^>]*aria-label="Theme"[^>]*>(.*?)<\/select>/)?.[1] ?? "";
    expect([...select.matchAll(/>([^<]+)<\/option>/g)].map(([, label]) => label)).toEqual(["System", "Light", "Dark"]);
  });

  it("lists the saved API keys under Accounts, only once a key is saved", () => {
    const models = { default: "", options: [] };
    fixture.instances = [
      { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription", snapshot: { state: "available", authenticated: true, version: "2.0.0" }, models },
      { instanceId: "openai", driverKind: "openai-compat", displayName: "OpenAI", access: "api", snapshot: { state: "available", authenticated: true }, models },
      { instanceId: "mistral", driverKind: "mistral", displayName: "Mistral", access: "api", snapshot: { state: "unavailable", authenticated: false }, models },
    ];
    const html = render();
    expect(groups(html)).toEqual(["later-dog-cloud", "accounts", "api-keys", "profile", "dogs", "appearance", "system", "help"]);
    expect(markers(html)).toEqual(["accounts", "api-keys=openai", "about-me", "permissions=microphone"]);
    expect(html).toContain(">API keys</div>");
  });

  it("asks for the microphone only on a Mac with the desktop bridge", () => {
    vi.stubGlobal("window", {});
    expect(markers(render())).toEqual(["accounts", "about-me"]);
    vi.stubGlobal("window", { laterdog: { ...MAC.laterdog, platform: "win32" } });
    expect(markers(render())).toEqual(["accounts", "about-me"]);
  });

  it("leaves System out where it would be empty", () => {
    vi.stubGlobal("window", {});
    expect(groups(render())).toEqual(["accounts", "profile", "dogs", "appearance", "help"]);
    fixture.analytics = true;
    expect(groups(render())).toEqual(["accounts", "profile", "dogs", "appearance", "system", "help"]);
  });

  it("leaves the later.dog Cloud group out when there is no Cloud bridge to fill it", () => {
    const { cloudAccount: _bridge, ...plain } = MAC.laterdog;
    vi.stubGlobal("window", { laterdog: plain });
    const html = render();
    expect(groups(html)).toEqual(["accounts", "profile", "dogs", "appearance", "system", "help"]);
    expect(html).not.toContain(">later.dog Cloud</div>");
  });

  it("ends with Help: Keyboard shortcuts, Help Center, Send Feedback and About", () => {
    const html = render();
    const help = html.slice(html.indexOf('data-settings-group="help"'));
    expect([...help.matchAll(/data-settings-help="([^"]+)"/g)].map((match) => match[1])).toEqual(["shortcuts", "help", "feedback", "about"]);
    const titles = ["Keyboard shortcuts", "Help Center", "Send Feedback", "About"].map((title) => help.indexOf(`>${title}</div>`));
    expect(titles.every((at) => at >= 0)).toBe(true);
    expect([...titles].sort((a, b) => a - b)).toEqual(titles);
    expect(help).toContain(">1.2.3 · macOS</div>");
    expect(help).toMatch(/>Keyboard shortcuts<\/div><div[^>]*>[^<]+<\/div>/);
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

  it("shows your computer with this Mac's permissions and cloud computers, nothing else", () => {
    const html = render();
    expect(currentPage(html)).toBe("computer");
    expect(groups(html)).toEqual(["your-computer", "cloud-computers"]);
    expect(markers(html)).toEqual(["permissions=accessibility+screen", "cloud-computers"]);
    const order = ["Your computer", "Cloud computers"].map((label) => html.indexOf(`>${label}</div>`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toMatch(/data-this-computer=""[^>]*>[\s\S]*?>This computer<\/span>/);
    expect(html).toContain("What macOS lets later.dog do on this Mac.");
    for (const gone of ["Execution on this computer", "data-execution-rows", "data-execution-dog", "VPS", "alias", "Local VM", "Boat", "built-in browser", "data-built-in-browser", "Route traffic", "This Mac<"]) expect(html).not.toContain(gone);
  });

  it("keeps your computer to the desktop app, with the Mac permissions only on a Mac", () => {
    vi.stubGlobal("window", {});
    expect(groups(render())).toEqual(["cloud-computers"]);
    vi.stubGlobal("window", { laterdog: { ...MAC.laterdog, platform: "linux" } });
    const linux = render();
    expect(groups(linux)).toEqual(["your-computer", "cloud-computers"]);
    expect(markers(linux)).toEqual(["cloud-computers"]);
  });

});

describe("Settings in the Cloud's window", () => {
  const pending = () => new Promise<never>(() => {});
  const CLOUD = { laterdog: {
    platform: "darwin",
    cloudPermissions: { status: vi.fn(), request: vi.fn(), openSettings: vi.fn() },
    cloudPlan: { state: vi.fn(pending), manage: vi.fn(), signOut: vi.fn() },
    cloudLending: { state: vi.fn(pending), setHome: vi.fn() },
  } };

  it("is the same Settings: the account card, and this Mac's permission rows on General and on Computer", () => {
    vi.stubGlobal("window", CLOUD);
    const general = render();
    expect(groups(general)).toEqual(["later-dog-cloud", "accounts", "profile", "dogs", "appearance", "system", "help"]);
    expect(general).toContain('data-cloud-account="on-cloud"');
    expect(markers(general)).toEqual(["accounts", "about-me", "permissions=microphone"]);
    expect(general).not.toContain("You&#x27;re on My Cloud");
    fixture.section = "computer";
    const computer = render();
    expect(groups(computer)).toEqual(["your-computer", "cloud-computers"]);
    expect(markers(computer)).toEqual(["lending", "permissions=accessibility+screen", "cloud-computers"]);
  });

  it("leaves the lending switch out when an older desktop app gives the Cloud only the old open call", () => {
    vi.stubGlobal("window", { laterdog: { ...CLOUD.laterdog, cloudLending: { open: vi.fn() } } });
    fixture.section = "computer";
    const computer = render();
    expect(groups(computer)).toEqual(["your-computer", "cloud-computers"]);
    expect(markers(computer)).toEqual(["permissions=accessibility+screen", "cloud-computers"]);
  });
});

describe("Usage & Billing", () => {
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
