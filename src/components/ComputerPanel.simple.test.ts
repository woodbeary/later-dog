import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";
import type { FeatureFlagConfig } from "@/lib/feature-flags";

const fixture = vi.hoisted(() => {
  const laterdog: Record<string, unknown> = {};
  vi.stubGlobal("window", { laterdog });
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return {
    laterdog,
    platform: "darwin" as "darwin" | "win32" | "linux",
    localComputer: { available: true, support: "supported", enabled: true, status: "ready" } as DesktopCapabilities["localComputer"],
    values: [] as unknown[],
    index: 0,
    own: 0,
    seed: {} as Record<string, unknown>,
    config: {} as FeatureFlagConfig & { cloudHome?: boolean; box?: { configured: boolean }; vps?: { configured: boolean; sshAlias: string } },
    instances: [] as InstanceInfo[],
    dispatch: (() => {}) as (...args: unknown[]) => void,
    api: (() => Promise.resolve({})) as (...args: unknown[]) => Promise<unknown>,
    ownerOrAdmin: null as boolean | null,
  };
});

const PHASE_OFFSETS = { phase: 0, resolved: 2, vmViewerUrl: 10, vmStatus: 11, error: 16 } as const;
let phaseIndex = -1;

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) {
      let value = typeof initial === "function" ? initial() : initial;
      if (value === "checking" && phaseIndex < 0) phaseIndex = index;
      for (const [name, offset] of Object.entries(PHASE_OFFSETS)) {
        if (phaseIndex >= 0 && index === phaseIndex + offset && name in fixture.seed) value = fixture.seed[name];
      }
      fixture.values[index] = value;
    }
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useEffect: () => {},
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));
vi.mock("./DesktopCapabilities", () => ({
  useCaptionChrome: () => ({ padClass: undefined }),
  useDesktopCapabilities: () => ({
    ready: true,
    capabilities: {
      host: { platform: fixture.platform, label: "Host", session: "unknown", packaged: true, homeDir: "/Users/me" },
      windowChrome: "native",
      screenPreview: { available: false, interaction: "none" },
      dictation: { available: false, engine: "none", onDevice: false },
      localComputer: fixture.localComputer,
    },
  }),
}));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => createElement("div", null, "BROWSER-PANEL") }));
vi.mock("./CloudScreenPreview", () => ({ CloudScreenPreview: () => null }));
vi.mock("./LocalScreenPreview", () => ({ LocalScreenPreview: () => null }));
vi.mock("./LinuxLocalControl", () => ({ LinuxLocalControl: () => null }));
vi.mock("./MacLocalControl", () => ({ MacLocalControl: () => createElement("div", null, "MAC-LOCAL") }));
vi.mock("./ApiKeys", async (importOriginal) => ({
  ...await importOriginal<typeof import("./ApiKeys")>(),
  ApiKeyRow: () => createElement("div", null, "BOAT-KEY-ROW"),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: (...args: unknown[]) => fixture.api(...args),
  useStore: () => ({
    state: {
      config: { box: { configured: true }, ...fixture.config },
      instances: fixture.instances,
      computerControl: {},
      routines: [],
      routineRuns: [],
    },
    dispatch: fixture.dispatch,
    flushBotPatches: () => Promise.resolve(null),
  }),
}));

const { ComputerPanel } = await import("./ComputerPanel");

afterAll(() => vi.unstubAllGlobals());

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function text(value: ReactNode): string {
  return Children.toArray(value).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    return isValidElement(child) ? text((child as Node).props.children) : "";
  }).join("").trim();
}

const engine = (): InstanceInfo => ({
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription",
  snapshot: { state: "available", version: "1", authenticated: true },
  models: { default: "m", options: [{ id: "m", label: "M" }] },
  capabilities: { computerMcp: true, browserMcp: true },
} as InstanceInfo);

function makeBot(patch: Partial<Bot> = {}): Bot {
  return {
    id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", notifications: true,
    color: "green", unread: false, messages: [],
    modelSelection: { instanceId: "claude", model: "m" },
    ...patch,
  } as Bot;
}

function render(forBot: Bot) {
  fixture.values.length = Math.min(fixture.values.length, fixture.own);
  let tree: ReactNode = null;
  function Capture() {
    fixture.index = 0;
    tree = ComputerPanel({ bot: forBot });
    fixture.own = fixture.index;
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  const buttons = all.filter((node) => node.type === "button");
  const button = (label: string) => buttons.find((node) => text(node.props.children) === label);
  const byTestId = (id: string) => all.find((node) => node.props["data-testid"] === id);
  return { html, nodes: all, buttons, button, byTestId };
}

const fresh = () => {
  fixture.values = [];
  phaseIndex = -1;
};
const cloudBox = { botId: "scout", threadId: "thread-scout", computer: "cloud", cloudBackend: "box" } as const;
const plainEngine = () => ({ ...engine(), displayName: "Plain", capabilities: { computerMcp: false, browserMcp: false } } as InstanceInfo);

beforeEach(() => {
  fixture.platform = "darwin";
  fixture.localComputer = { available: true, support: "supported", enabled: true, status: "ready" } as DesktopCapabilities["localComputer"];
  fixture.values = [];
  fixture.index = 0;
  fixture.own = 0;
  fixture.seed = {};
  phaseIndex = -1;
  fixture.config = { features: { browser: true }, browserEngine: { kind: "engine" } };
  fixture.instances = [engine()];
  fixture.dispatch = vi.fn();
  fixture.api = vi.fn(() => Promise.resolve({ features: { browser: true } }));
  fixture.ownerOrAdmin = null;
  for (const key of Object.keys(fixture.laterdog)) delete fixture.laterdog[key];
});

describe("Computer panel", () => {
  it("is one Computer view with a close button, and no tabs or where-works picker", () => {
    const rendered = render(makeBot());
    expect(text(rendered.nodes.find((node) => node.type === "h2")!.props.children)).toBe("Computer");
    expect(rendered.buttons.filter((node) => ["Computer", "Browser", "Files"].includes(text(node.props.children)))).toEqual([]);
    expect(rendered.html).not.toContain("computer-tabs");
    expect(rendered.html).not.toContain("Where Scout works");
    const close = rendered.nodes.find((node) => node.props["aria-label"] === "Close computer panel")!;
    (close.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleComputer", open: false });
  });

  it("pulses its live dot while a turn runs wherever the dog works, and never for Off", () => {
    expect(render(makeBot({ computer: "cloud", busy: true })).byTestId("computer-live")).toBeDefined();
    fresh();
    expect(render(makeBot({ computer: "browser", busy: true })).byTestId("computer-live")).toBeDefined();
    fresh();
    expect(render(makeBot({ computer: "cloud" })).byTestId("computer-live")).toBeUndefined();
    fresh();
    expect(render(makeBot({ computer: "off", busy: true })).byTestId("computer-live")).toBeUndefined();
  });

  it("sends the person of a dog with no screen to where it works", () => {
    fixture.seed = { phase: "off" };
    const rendered = render(makeBot({ computer: "off" }));
    expect(rendered.html).toContain("Scout has no screen. It can still chat and do anything that doesn&#x27;t need one.");
    const choose = rendered.byTestId("choose-where-works")!;
    expect(text(choose.props.children)).toBe("Choose where Scout works");
    (choose.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleSettings", open: true, section: "access", botId: "scout" });
  });
});

describe("The built-in browser", () => {
  const turnOn = (rendered: ReturnType<typeof render>) => rendered.byTestId("browser-turn-on")!;

  it("is the whole panel for a dog that works in the browser", () => {
    const rendered = render(makeBot({ computer: "browser" }));
    expect(rendered.byTestId("computer-browser")).toBeDefined();
    expect(rendered.html).toContain("BROWSER-PANEL");
    expect(rendered.html).not.toContain("Scout&#x27;s screen");
  });

  it("never shows for a dog that works anywhere else", () => {
    for (const computer of [undefined, "cloud", "vm", "local", "off"] as const) {
      fresh();
      const rendered = render(makeBot({ computer }));
      expect(rendered.html, String(computer)).not.toContain("BROWSER-PANEL");
      expect(rendered.html, String(computer)).toContain("Scout&#x27;s screen");
    }
  });

  it("explains when it is off and turns on the same installation setting as Settings", async () => {
    fixture.config = { features: { browser: false }, browserEngine: { kind: "engine" } };
    const rendered = render(makeBot({ computer: "browser" }));
    expect(rendered.html).toContain("The browser is off");
    expect(rendered.html).toContain("Turn on the built-in browser to watch Scout browse the web, and take over any time.");
    expect(rendered.html).not.toContain("BROWSER-PANEL");
    (turnOn(rendered).props.onClick as () => void)();
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: { features: { browser: true } } }));
    expect(fixture.api).toHaveBeenCalledWith("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ features: { browser: true } }),
    });
  });

  it("turns on only this dog's browser when only that is off", async () => {
    const rendered = render(makeBot({ computer: "browser", browser: false }));
    expect(rendered.html).toContain("The browser is off");
    (turnOn(rendered).props.onClick as () => void)();
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "scout", patch: { browser: true } }));
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("tells a User to ask an Admin instead of offering a switch only an Admin can use", () => {
    fixture.config = { features: { browser: false }, browserEngine: { kind: "engine" } };
    fixture.ownerOrAdmin = false;
    const rendered = render(makeBot({ computer: "browser" }));
    expect(rendered.html).toContain("The browser is off");
    expect(rendered.html).toContain("The built-in browser is switched off. Ask an Admin to change it.");
    expect(rendered.byTestId("browser-turn-on")).toBeUndefined();
  });

  it("says why when this server cannot have a browser", () => {
    fixture.config = { features: { browser: false }, browserEngine: { kind: "unavailable", reason: "No engine here." } };
    const rendered = render(makeBot({ computer: "browser" }));
    expect(rendered.html).toContain("No engine here.");
    expect(turnOn(rendered).props.disabled).toBe(true);
  });

  it("names a model that cannot browse and offers a different one", () => {
    fixture.instances = [plainEngine()];
    const rendered = render(makeBot({ computer: "browser" }));
    expect(text(rendered.byTestId("browser-cannot")!.props.children)).toBe("M can't use the built-in browser.Choose a model");
    (rendered.byTestId("place-action")!.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleSettings", open: true, section: "model", botId: "scout" });
  });
});

describe("This Mac", () => {
  it("asks for the grants This Mac is missing in place of its screen: the two rows computer control needs, nothing more", () => {
    fixture.laterdog.platform = "darwin";
    fixture.laterdog.permissions = { status: vi.fn(), request: vi.fn(), openSettings: vi.fn() };
    fixture.localComputer = {
      available: false, support: "unsupported", enabled: false, status: "unavailable", reasonCode: "cua-driver-unavailable",
      message: "Accessibility and Screen Recording required; later.dog asks for them when a dog first uses this Mac",
    } as DesktopCapabilities["localComputer"];
    fixture.seed = { phase: "local-unavailable" };
    const rendered = render(makeBot({ computer: "local" }));
    expect(rendered.html).toContain('data-testid="local-computer-permissions"');
    expect(rendered.html).toContain("Let Scout use this Mac");
    expect(rendered.html).toContain("macOS asks for each one. Allow both and Scout can get going.");
    expect([...rendered.html.matchAll(/data-permission="([^"]+)"/g)].map((match) => match[1])).toEqual(["accessibility", "screen"]);
    expect(rendered.html).not.toContain("Microphone");
    expect(rendered.html).not.toContain("Settings → Computers → Permissions");
    expect(rendered.html).not.toContain('data-testid="open-permissions"');
    expect(rendered.html).not.toContain("animate-spin");
    expect(rendered.html).not.toContain("MAC-LOCAL");
  });

  it("shows the Mac control card only for a dog that works on This Mac", () => {
    expect(render(makeBot({ computer: "local" })).html).toContain("MAC-LOCAL");
    for (const computer of [undefined, "cloud", "vm", "browser", "off"] as const) {
      fresh();
      expect(render(makeBot({ computer })).html, String(computer)).not.toContain("MAC-LOCAL");
    }
  });

  it("asks for no macOS grants for a model that cannot control this Mac anyway", () => {
    fixture.laterdog.platform = "darwin";
    fixture.laterdog.permissions = { status: vi.fn(), request: vi.fn(), openSettings: vi.fn() };
    fixture.localComputer = {
      available: false, support: "unsupported", enabled: false, status: "unavailable", reasonCode: "cua-driver-unavailable",
      message: "Accessibility and Screen Recording required; later.dog asks for them when a dog first uses this Mac",
    } as DesktopCapabilities["localComputer"];
    fixture.instances = [plainEngine()];
    fixture.seed = { phase: "local-unavailable" };
    const rendered = render(makeBot({ computer: "local" }));
    expect(rendered.html).not.toContain('data-testid="local-computer-permissions"');
  });
});

describe("Local VM", () => {
  it("names a model that cannot use it in plain words and offers a different one", () => {
    fixture.instances = [plainEngine()];
    fixture.seed = { phase: "vm-unavailable" };
    const rendered = render(makeBot({ computer: "vm" }));
    expect(rendered.html).toContain("M can&#x27;t use a Local VM. Choose a model that can, such as Claude or ChatGPT.");
    expect(rendered.html).not.toContain("ACP");
    expect(rendered.nodes.some((node) => node.props.role === "alert")).toBe(false);
    const action = rendered.byTestId("place-action")!;
    expect(text(action.props.children)).toBe("Choose a model");
    (action.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleSettings", open: true, section: "model", botId: "scout" });
  });
});

describe("Cloud computer", () => {
  it("reads a refused start as the same state a failed row does, never the relay's words", () => {
    fixture.seed = {
      phase: "error",
      resolved: { botId: "scout", threadId: "thread-scout", computer: "cloud", cloudBackend: "box" },
      error: "Your Personal plan includes 1 cloud computer at once. Delete one to start another.",
    };
    const rendered = render(makeBot({ computer: "cloud" }));
    expect(rendered.html).toContain("All the cloud computers your plan includes are in use.");
    expect(rendered.html).not.toContain("Delete one to start another");
    const actions = rendered.nodes.filter((node) => node.props["data-testid"] === "place-action").map((node) => text(node.props.children));
    expect(actions).toContain("Manage cloud computers");
    (rendered.nodes.find((node) => node.props["data-testid"] === "place-action")!.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "computer" });
  });

  it("puts the Boat key row under an Admin's screen, and tells a User to ask an Admin", () => {
    fixture.config = { ...fixture.config, box: { configured: false } };
    fixture.seed = { phase: "unconfigured", resolved: cloudBox };
    const admin = render(makeBot({ computer: "cloud" }));
    expect(admin.html).toContain("A cloud computer here needs your own Boat key, a paid service.");
    expect(admin.html).toContain("BOAT-KEY-ROW");

    fresh();
    fixture.ownerOrAdmin = false;
    const user = render(makeBot({ computer: "cloud" }));
    expect(user.html).toContain("A cloud computer here needs your own Boat key, a paid service. Ask an Admin to change it.");
    expect(user.html).not.toContain("BOAT-KEY-ROW");
    expect(user.byTestId("place-action")).toBeUndefined();
  });

  it("lets a dog whose tools leave out the computer use it, in one click from here", async () => {
    const api = vi.fn(async (..._args: unknown[]) => ({}));
    fixture.api = api;
    fixture.seed = { phase: "cloud-new", resolved: cloudBox };
    const rendered = render(makeBot({ computer: "cloud", toolScope: { deny: ["mcp:computer:*", "native:bash"] } }));
    expect(rendered.html).toContain("What Scout can use doesn&#x27;t include a computer.");
    const action = rendered.byTestId("place-action")!;
    expect(text(action.props.children)).toBe("Let Scout use the computer");
    (action.props.onClick as () => void)();
    await Promise.resolve();
    expect(api).toHaveBeenCalledWith("/api/bots/scout", { method: "PATCH", body: JSON.stringify({ toolScope: { deny: ["native:bash"] } }) });
  });
});

describe("Technical controls", () => {
  const cloud = () => makeBot({ computer: "cloud" });

  it("has no gear, backend picker or Routines card", () => {
    const rendered = render(cloud());
    expect(rendered.nodes.some((node) => node.props.title === "Dog settings")).toBe(false);
    expect(rendered.html).not.toContain("Works on");
    expect(rendered.html).not.toContain("Boat");
    expect(rendered.buttons.some((node) => text(node.props.children).startsWith("Routines"))).toBe(false);
  });

  it("has no VM settings link", () => {
    expect(render(makeBot({ computer: "vm" })).html).not.toContain("VM settings");
  });

  it("shows Take control, Full screen and Sleep under a ready cloud screen", () => {
    fixture.seed = { phase: "ready", resolved: { botId: "scout", threadId: "thread-scout", computer: "cloud", cloudBackend: "box" } };
    const simple = render(cloud());
    const row = simple.nodes.find((node) => node.props["data-testid"] === "computer-actions")!;
    expect(nodes(row.props.children).filter((node) => node.type === "button").map((node) => text(node.props.children)))
      .toEqual(["Take control", "Full screen", "Sleep"]);
  });

  it("has no two desktops or Delete VM under a running VM", () => {
    fixture.laterdog.desktopWorkspace = {};
    fixture.seed = {
      phase: "vm",
      resolved: { botId: "scout", threadId: "thread-scout", computer: "vm", cloudBackend: "box" },
      vmViewerUrl: "http://127.0.0.1/viewer",
      vmStatus: { mode: "per-bot", container: "running", ready: true },
    };
    const rendered = render(makeBot({ computer: "vm" }));
    expect(rendered.html).not.toContain("two desktops");
    expect(rendered.html).not.toContain("Delete");
    const row = rendered.nodes.find((node) => node.props["data-testid"] === "computer-actions")!;
    expect(nodes(row.props.children).filter((node) => node.type === "button").map((node) => text(node.props.children)))
      .toEqual(["Take control", "Full screen"]);
  });

  it("says a VPS computer is stopped and offers one Start, with no VPS setup controls", () => {
    fixture.seed = { phase: "vps-stopped", resolved: { botId: "scout", threadId: "thread-scout", computer: "cloud", cloudBackend: "vps" } };
    const rendered = render(makeBot({ computer: "cloud", cloudBackend: "vps" }));
    expect(rendered.html).toContain("The managed VPS computer is stopped");
    expect(rendered.buttons.some((node) => /VPS|advanced/i.test(text(node.props.children)))).toBe(false);
    const start = rendered.button("Start it now")!;
    (start.props.onClick as () => void)();
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout/computer/provision", { method: "POST" });
  });

  it("asks for the server's SSH alias right in the panel while a VPS computer has none", () => {
    const vps = () => {
      fixture.values = [];
      phaseIndex = -1;
      fixture.seed = { phase: "vps-unconfigured", resolved: { botId: "scout", threadId: "thread-scout", computer: "cloud", cloudBackend: "vps" } };
      return render(makeBot({ computer: "cloud", cloudBackend: "vps" })).html;
    };
    expect(vps()).toContain('aria-label="Self-hosted VPS SSH config alias"');

    fixture.config = { ...fixture.config, vps: { configured: true, sshAlias: "my-vps" } };
    expect(vps()).not.toContain("data-vps-alias");

    fixture.config = { ...fixture.config, vps: undefined };
    fixture.laterdog.remoteClient = { active: true };
    expect(vps()).not.toContain("data-vps-alias");
  });
});
