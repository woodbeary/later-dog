import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo, Message, Task } from "@/state/store";
import type { FeatureFlagConfig } from "@/lib/feature-flags";

// Same hook-by-call-order harness as ModelPicker.simple.test.ts: the panel's
// own state survives between renders, effects never run, and handlers are
// read off the returned element tree. `seed` presets the state the resolve
// effect would have reached (it never runs here).
const fixture = vi.hoisted(() => {
  const view = { current: "computer" as string };
  const laterdog: Record<string, unknown> = {};
  vi.stubGlobal("window", { laterdog });
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("localStorage", { getItem: (key: string) => key.startsWith("laterdog-computer-panel-view") ? view.current : null, setItem: () => {} });
  return {
    view,
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

// The panel's useState calls in source order, counted from `phase` (the only
// one that starts as "checking"). Keep in step with ComputerPanel.tsx.
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
vi.mock("./MacLocalControl", () => ({ MacLocalControl: () => null }));
vi.mock("./LocalComputerAutoWarning", () => ({ LocalComputerAutoWarning: () => null }));
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
const { ComputerFilesPane } = await import("./ComputerFilesPane");
const { LocalComputerAutoWarning } = await import("./LocalComputerAutoWarning");

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
  return { html, nodes: all, buttons, button };
}

const tabs = (rendered: ReturnType<typeof render>) => {
  const bar = rendered.nodes.find((node) => node.props["data-testid"] === "computer-tabs")!;
  return nodes(bar.props.children).filter((node) => node.type === "button").map((node) => text(node.props.children));
};
const placeLine = (rendered: ReturnType<typeof render>) =>
  text(rendered.nodes.find((node) => node.props["data-testid"] === "place-line")!.props.children).replace(/&#x27;/g, "'");
const grid = (rendered: ReturnType<typeof render>) => {
  const card = rendered.nodes.find((node) => node.props["data-testid"] === "where-works");
  if (!card) return [];
  return nodes(card.props.children).filter((node) => node.type === "button");
};

beforeEach(() => {
  fixture.view.current = "computer";
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

describe("Computer panel tabs", () => {
  it("centres the tabs as a pill with close pinned right", () => {
    const rendered = render(makeBot());
    const bar = rendered.nodes.find((node) => node.props["data-testid"] === "computer-tabs")!;
    expect(String(bar.props.className).split(" ")).toEqual(expect.arrayContaining(["justify-center", "rounded-full", "mx-9"]));
    const row = rendered.nodes.find((node) => Children.toArray(node.props.children)
      .some((child) => isValidElement(child) && (child as Node).props["data-testid"] === "computer-tabs"))!;
    expect(String(row.props.className).split(" ")).toEqual(expect.arrayContaining(["relative", "flex", "justify-center"]));
    const close = rendered.nodes.find((node) => node.props["aria-label"] === "Close computer panel")!;
    expect(String(close.props.className).split(" ")).toEqual(expect.arrayContaining(["absolute", "right-0"]));
  });

  it("shows Computer, Browser and Files, with the browser on or off", () => {
    expect(tabs(render(makeBot()))).toEqual(["Computer", "Browser", "Files"]);
    fixture.config = {};
    fixture.values = [];
    expect(tabs(render(makeBot()))).toEqual(["Computer", "Browser", "Files"]);
  });

  it("reads a Routines or Android view stored by the old Advanced mode as the Computer tab", () => {
    for (const stored of ["routines", "android"]) {
      fixture.view.current = stored;
      fixture.values = [];
      phaseIndex = -1;
      const rendered = render(makeBot());
      expect(rendered.nodes.find((node) => node.props["data-testid"] === "where-works"), stored).toBeDefined();
    }
  });

  it("lists the files this chat changed in the Files tab", () => {
    fixture.view.current = "files";
    const digest = (files: { added?: string[]; changed?: string[]; deleted?: string[] }) => ({
      id: Math.random().toString(36), role: "assistant", kind: "digest", text: "",
      digest: { files: { added: [], changed: [], deleted: [], ...files } },
    }) as unknown as Message;
    const rendered = render(makeBot({ messages: [
      digest({ added: ["/Users/me/work/report.md", "/Users/me/work/old.txt"] }),
      digest({ changed: ["/Users/me/work/notes.md"], deleted: ["/Users/me/work/old.txt"] }),
    ] }));
    expect(rendered.nodes.some((node) => node.type === ComputerFilesPane)).toBe(true);
    expect(rendered.html).toContain("notes.md");
    expect(rendered.html).toContain("report.md");
    expect(rendered.html).not.toContain("old.txt");
    expect(rendered.html).toContain("~/work");
    expect(rendered.html).toContain("Scout&#x27;s private folder");
  });

  it("explains an empty Files tab", () => {
    fixture.view.current = "files";
    expect(render(makeBot()).html).toContain("Files Scout makes or changes in this chat will show up here.");
  });
});

describe("Browser tab with the browser off", () => {
  it("explains and turns on the same installation setting as Settings", async () => {
    fixture.view.current = "browser";
    fixture.config = { features: { browser: false }, browserEngine: { kind: "engine" } };
    const rendered = render(makeBot());
    expect(rendered.html).toContain("The browser is off");
    expect(rendered.html).not.toContain("BROWSER-PANEL");
    (browserSwitch(rendered).props.onClick as () => void)();
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: { features: { browser: true } } }));
    expect(fixture.api).toHaveBeenCalledWith("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ features: { browser: true } }),
    });
  });

  it("turns on this bot's own browser switch when only that is off", async () => {
    fixture.view.current = "browser";
    const rendered = render(makeBot({ browser: false }));
    expect(browserSwitch(rendered).props.checked).toBe(false);
    (browserSwitch(rendered).props.onClick as () => void)();
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "scout", patch: { browser: true } }));
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("says why when this server cannot have a browser", () => {
    fixture.view.current = "browser";
    fixture.config = { features: { browser: false }, browserEngine: { kind: "unavailable", reason: "No engine here." } };
    const rendered = render(makeBot());
    expect(rendered.html).toContain("No engine here.");
    expect(browserSwitch(rendered).props.disabled).toBe(true);
  });

  it("shows the real browser once it is on, under a switch that turns it off for this bot only", () => {
    fixture.view.current = "browser";
    const rendered = render(makeBot());
    expect(rendered.html).toContain("BROWSER-PANEL");
    expect(browserSwitch(rendered).props.checked).toBe(true);
    (browserSwitch(rendered).props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "scout", patch: { browser: false } });
    expect(fixture.api).not.toHaveBeenCalled();
  });
});

function browserSwitch(rendered: ReturnType<typeof render>) {
  return rendered.nodes.find((node) => node.props["aria-label"] === "Let Scout use a browser")!;
}

describe("Where the bot works", () => {
  it("offers six places in a 3-column grid with plain names", () => {
    const rendered = render(makeBot());
    const card = rendered.nodes.find((node) => node.props["data-testid"] === "where-works")!;
    expect(rendered.html).toContain("Where Scout works");
    expect(nodes(card.props.children).find((node) => node.props.role === "group")!.props.className).toContain("grid-cols-3");
    expect(grid(rendered).map((node) => text(node.props.children))).toEqual(["Auto", "Cloud computer", "Local VM", "This Mac", "Browser", "Off"]);
    expect(placeLine(rendered)).toBe("Uses the built-in browser, a private desktop on this computer, or this computer's screen, whichever the task needs.");
  });

  it("says This PC off a Mac, and never names a Local VM in Auto's line there", () => {
    fixture.platform = "win32";
    const rendered = render(makeBot());
    expect(grid(rendered).map((node) => text(node.props.children))).toContain("This PC");
    expect(placeLine(rendered)).not.toMatch(/Local VM|Boat|cloud box/i);
  });

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
    // macOS keeps the tile pickable before the grant (localComputerSelectable), so the grid itself is not where it says so
    expect(grid(rendered).find((node) => text(node.props.children) === "This Mac")!.props.disabled).toBeFalsy();
  });

  it("says what Auto does on My Cloud, where it starts a cloud computer by itself", () => {
    fixture.config = { ...fixture.config, cloudHome: true };
    expect(placeLine(render(makeBot()))).toBe("Uses the built-in browser. In a chat, it starts its cloud computer by itself when a task needs desktop apps.");
  });

  it("J11: a tile names its problem in a few words, and the whole line on hover", () => {
    fixture.instances = [{ ...engine(), displayName: "Plain", capabilities: { computerMcp: false, browserMcp: true } } as InstanceInfo];
    const tile = grid(render(makeBot())).find((node) => text(node.props.children).startsWith("Cloud computer"))!;
    expect(tile.props.disabled).toBe(true);
    expect(text(tile.props.children)).toBe("Cloud computerNot with this model");
    expect(tile.props.title).toBe("M can't use a computer. Choose a model that can, such as Claude or ChatGPT.");
  });

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

  it("offers the one next action for the chosen place, and a User is told to ask an Admin", () => {
    fixture.config = { ...fixture.config, box: { configured: false } };
    const rendered = render(makeBot({ computer: "cloud" }));
    expect(placeLine(rendered)).toBe("A cloud computer here needs your own Boat key, a paid service.Add Boat key");
    (rendered.nodes.find((node) => node.props["data-testid"] === "place-action")!.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "computer" });

    fixture.ownerOrAdmin = false;
    fixture.values = [];
    phaseIndex = -1;
    const user = render(makeBot({ computer: "cloud" }));
    expect(placeLine(user)).toBe("A cloud computer here needs your own Boat key, a paid service. Ask an Admin to change it.");
    expect(user.nodes.some((node) => node.props["data-testid"] === "place-action")).toBe(false);
  });

  it("lets a dog whose tools leave out the computer use it, in one click from here", async () => {
    const api = vi.fn(async (..._args: unknown[]) => ({}));
    fixture.api = api;
    const rendered = render(makeBot({ computer: "cloud", toolScope: { deny: ["mcp:computer:*", "native:bash"] } }));
    expect(placeLine(rendered)).toBe("What Scout can use doesn't include a computer.Let Scout use the computer");
    (rendered.nodes.find((node) => node.props["data-testid"] === "place-action")!.props.onClick as () => void)();
    await Promise.resolve();
    expect(api).toHaveBeenCalledWith("/api/bots/scout", { method: "PATCH", body: JSON.stringify({ toolScope: { deny: ["native:bash"] } }) });
  });

  it("saves each place as the dog's Works on, turning the browser on with Browser", () => {
    const expected = [
      { computer: null },
      { computer: "cloud" },
      { computer: "vm" },
      { computer: "local" },
      { computer: "browser", browser: true },
      { computer: "off" },
    ];
    for (const [index, patch] of expected.entries()) {
      fixture.values = [];
      phaseIndex = -1;
      fixture.dispatch = vi.fn();
      const rendered = render(makeBot({ computer: patch.computer === "off" ? "cloud" : "off" }));
      const group = rendered.nodes.find((node) => node.props.role === "group" && node.props["aria-label"] === "Computer destination")!;
      (nodes(group.props.children).filter((node) => node.type === "button")[index]!.props.onClick as () => void)();
      expect((fixture.dispatch as ReturnType<typeof vi.fn>).mock.calls).toEqual([[{ type: "updateBot", botId: "scout", patch }]]);
    }
  });

  it("asks before letting an auto-approving bot use this Mac", () => {
    const start = makeBot({ computer: "off", approvalMode: "auto" } as Partial<Bot>);
    const rendered = render(start);
    (grid(rendered).find((node) => text(node.props.children) === "This Mac")!.props.onClick as () => void)();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    const warning = render(start).nodes.find((node) => node.type === LocalComputerAutoWarning)!;
    expect(warning.props.open).toBe(true);
    (warning.props.onConfirm as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({
      type: "updateBot", botId: "scout", patch: { computer: "local", acknowledgeLocalAuto: true },
    });
  });
});

describe("A chat pinned to a place", () => {
  const pinned = () => makeBot({ tasks: [{ threadId: "thread-scout", title: "", createdAt: 1, surface: "cloud" }] } as Partial<Bot>);
  const note = (rendered: ReturnType<typeof render>) =>
    text(rendered.nodes.find((node) => node.props["data-testid"] === "place-pinned-note")!.props.children);

  it("names the place in the grid's words, never pointing at a composer chip", () => {
    expect(note(render(pinned()))).toBe("This chat is pinned to “Cloud computer”.");
  });

  const pinnedOn = (computer: Bot["computer"], task: Partial<Task> = {}) =>
    makeBot({ computer, tasks: [{ threadId: "thread-scout", title: "", createdAt: 1, surface: "cloud", ...task }] } as Partial<Bot>);
  const unpin = (rendered: ReturnType<typeof render>) => rendered.nodes.find((node) => node.props["data-testid"] === "place-unpin");
  const fresh = () => { fixture.values = []; phaseIndex = -1; };

  it("leads a person's pin back to the grid's choice", () => {
    const button = unpin(render(pinned()))!;
    expect(text(button.props.children)).toBe("Use Auto");
    expect(button.props.disabled).toBe(false);
    (button.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateTask", botId: "scout", threadId: "thread-scout", patch: { surface: null } });

    fresh();
    expect(text(unpin(render(pinnedOn("local")))!.props.children)).toBe("Use This Mac");
  });

  it("waits out a running turn, as the server refuses a busy chat's place change", () => {
    const button = unpin(render(pinnedOn(undefined, { busy: true })))!;
    expect(button.props.disabled).toBe(true);
    expect(button.props.title).toBe("Wait for the current turn to finish");
  });

  it("says nothing of a pin Auto recorded, one matching Works on, or one Off overrides", () => {
    for (const bot of [pinnedOn(undefined, { surface: "browser", surfaceAuto: true }), pinnedOn("cloud"), pinnedOn("off")]) {
      fresh();
      const rendered = render(bot);
      expect(rendered.nodes.some((node) => node.props["data-testid"] === "place-pinned-note"), JSON.stringify([bot.computer, bot.tasks])).toBe(false);
      expect(unpin(rendered)).toBeUndefined();
    }
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
