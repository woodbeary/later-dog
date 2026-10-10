import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";
import type { FeatureFlagConfig } from "@/lib/feature-flags";

const fixture = vi.hoisted(() => {
  const laterdog: Record<string, unknown> = {};
  vi.stubGlobal("window", { laterdog });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return {
    laterdog,
    platform: "darwin" as "darwin" | "win32" | "linux",
    localComputer: { available: true, support: "supported", enabled: true, status: "ready" } as DesktopCapabilities["localComputer"],
    values: [] as unknown[],
    index: 0,
    own: 0,
    config: {} as FeatureFlagConfig & { cloudHome?: boolean; box?: { configured: boolean } },
    instances: [] as InstanceInfo[],
    dispatch: (() => {}) as (...args: unknown[]) => void,
    api: (() => Promise.resolve({})) as (...args: unknown[]) => Promise<unknown>,
    ownerOrAdmin: null as boolean | null,
  };
});

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useEffect: () => {},
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));
vi.mock("./DesktopCapabilities", () => ({
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
vi.mock("./LocalComputerAutoWarning", () => ({ LocalComputerAutoWarning: () => null }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: (...args: unknown[]) => fixture.api(...args),
  useStore: () => ({
    state: { config: { box: { configured: true }, ...fixture.config }, instances: fixture.instances },
    dispatch: fixture.dispatch,
  }),
}));

const { WorksOnPicker, WORKS_ON } = await import("./WorksOnPicker");
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

function render(bot: Bot) {
  fixture.values.length = Math.min(fixture.values.length, fixture.own);
  let tree: ReactNode = null;
  function Capture() {
    fixture.index = 0;
    tree = WorksOnPicker({ bot });
    fixture.own = fixture.index;
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  const byTestId = (id: string) => all.find((node) => node.props["data-testid"] === id);
  const select = byTestId("works-on-select")!;
  const options = all.filter((node) => node.type === "option");
  return {
    html,
    nodes: all,
    select,
    options,
    labels: options.map((node) => text(node.props.children)),
    line: text(byTestId("works-on-line")!.props.children),
    action: byTestId("works-on-action"),
    choose: (value: string) => (select.props.onChange as (event: unknown) => void)({ target: { value } }),
  };
}

const fresh = () => {
  fixture.values = [];
  fixture.own = 0;
};

beforeEach(() => {
  fixture.platform = "darwin";
  fixture.localComputer = { available: true, support: "supported", enabled: true, status: "ready" } as DesktopCapabilities["localComputer"];
  fresh();
  fixture.index = 0;
  fixture.config = { features: { browser: true }, browserEngine: { kind: "engine" } };
  fixture.instances = [engine()];
  fixture.dispatch = vi.fn();
  fixture.api = vi.fn(() => Promise.resolve({ features: { browser: true } }));
  fixture.ownerOrAdmin = null;
  for (const key of Object.keys(fixture.laterdog)) delete fixture.laterdog[key];
});

describe("Where the dog works", () => {
  it("offers six places in plain names, Auto when nothing is chosen, with Auto's line under them", () => {
    const rendered = render(makeBot());
    expect(rendered.html).toContain("Where Scout works");
    expect(rendered.labels).toEqual(["Auto", "Cloud computer", "Local VM", "This Mac", "Browser", "Off"]);
    expect(rendered.select.props.value).toBe("auto");
    expect(rendered.line).toBe("Uses the built-in browser, a private desktop on this computer, or this computer's screen, whichever the task needs.");
    expect(rendered.action).toBeUndefined();
  });

  it("shows the chosen place and its own line", () => {
    const rendered = render(makeBot({ computer: "browser" }));
    expect(rendered.select.props.value).toBe("browser");
    expect(rendered.line).not.toBe(render(makeBot()).line);
  });

  it("says This PC off a Mac, and never names a Local VM in Auto's line there", () => {
    fixture.platform = "win32";
    const rendered = render(makeBot());
    expect(rendered.labels).toContain("This PC");
    expect(rendered.line).not.toMatch(/Local VM|Boat|cloud box/i);
  });

  it("leaves out this computer and a Local VM on My Cloud, and says what Auto does there", () => {
    fixture.config = { ...fixture.config, cloudHome: true };
    expect(render(makeBot()).labels).toEqual(["Auto", "Cloud computer", "Browser", "Off"]);
    expect(render(makeBot()).line).toBe("Uses the built-in browser. In a chat, it starts its cloud computer by itself when a task needs desktop apps.");
  });

  it("names a place's problem in a few words and greys it out, with the whole line on hover", () => {
    fixture.instances = [{ ...engine(), displayName: "Plain", capabilities: { computerMcp: false, browserMcp: true } } as InstanceInfo];
    const cloud = render(makeBot()).options.find((node) => node.props.value === "cloud")!;
    expect(text(cloud.props.children)).toBe("Cloud computer · Not with this model");
    expect(cloud.props.disabled).toBe(true);
    expect(cloud.props.title).toBe("M can't use a computer. Choose a model that can, such as Claude or ChatGPT.");
  });

  it("lets an Admin pick Browser while the browser is off, since the line under it turns it on", () => {
    fixture.config = { features: { browser: false }, browserEngine: { kind: "engine" } };
    const browser = render(makeBot()).options.find((node) => node.props.value === "browser")!;
    expect(text(browser.props.children)).toBe("Browser · Browser is off");
    expect(browser.props.disabled).toBe(false);
    fixture.ownerOrAdmin = false;
    fresh();
    expect(render(makeBot()).options.find((node) => node.props.value === "browser")!.props.disabled).toBe(true);
  });

  it("counts a browser that still needs its one-time download as ready, and greys it where it can never run", () => {
    fixture.config = { features: { browser: true }, browserEngine: { kind: "unavailable", installable: true } };
    const browser = render(makeBot()).options.find((node) => node.props.value === "browser")!;
    expect(text(browser.props.children)).toBe("Browser");
    expect(browser.props.disabled).toBe(false);
    for (const features of [{ browser: true }, { browser: false }]) {
      fixture.config = { features, browserEngine: { kind: "unavailable", installable: false } };
      fresh();
      expect(render(makeBot()).options.find((node) => node.props.value === "browser")!.props.disabled).toBe(true);
    }
  });

  it("keeps This Mac pickable before macOS grants, which later.dog asks for on first use", () => {
    fixture.localComputer = {
      available: false, support: "unsupported", enabled: false, status: "unavailable", reasonCode: "cua-driver-unavailable",
      message: "Accessibility and Screen Recording required; later.dog asks for them when a dog first uses this Mac",
    } as DesktopCapabilities["localComputer"];
    const local = render(makeBot()).options.find((node) => node.props.value === "local")!;
    expect(local.props.disabled).toBeFalsy();
  });

  it("saves each place as the dog's choice, turning the browser on with Browser", () => {
    const expected = [
      { computer: null },
      { computer: "cloud" },
      { computer: "vm" },
      { computer: "local" },
      { computer: "browser", browser: true },
      { computer: "off" },
    ];
    for (const [index, patch] of expected.entries()) {
      fresh();
      fixture.dispatch = vi.fn();
      render(makeBot({ computer: patch.computer === "off" ? "cloud" : "off" })).choose(WORKS_ON[index]!);
      expect((fixture.dispatch as ReturnType<typeof vi.fn>).mock.calls).toEqual([[{ type: "updateBot", botId: "scout", patch }]]);
    }
  });

  it("changes nothing when the same place is picked again", () => {
    render(makeBot({ computer: "cloud" })).choose("cloud");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("asks before letting an Off-leash dog use this Mac", () => {
    const bot = makeBot({ computer: "off", approvalMode: "auto" } as Partial<Bot>);
    render(bot).choose("local");
    expect(fixture.dispatch).not.toHaveBeenCalled();
    const warning = render(bot).nodes.find((node) => node.type === LocalComputerAutoWarning)!;
    expect(warning.props.open).toBe(true);
    (warning.props.onConfirm as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({
      type: "updateBot", botId: "scout", patch: { computer: "local", acknowledgeLocalAuto: true },
    });
    expect(render(bot).nodes.find((node) => node.type === LocalComputerAutoWarning)!.props.open).toBe(false);
  });

  it("offers the one next step for the chosen place, and tells a User to ask an Admin", () => {
    fixture.config = { ...fixture.config, box: { configured: false } };
    const admin = render(makeBot({ computer: "cloud" }));
    expect(admin.line).toBe("A cloud computer here needs your own Boat key, a paid service.");
    expect(text(admin.action!.props.children)).toBe("Add Boat key");
    (admin.action!.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "computer" });

    fixture.ownerOrAdmin = false;
    fresh();
    const user = render(makeBot({ computer: "cloud" }));
    expect(user.line).toBe("A cloud computer here needs your own Boat key, a paid service. Ask an Admin to change it.");
    expect(user.action).toBeUndefined();
  });

  it("lets a dog whose tools leave out the computer use it, in one click", async () => {
    const rendered = render(makeBot({ computer: "cloud", toolScope: { deny: ["mcp:computer:*", "native:bash"] } }));
    expect(rendered.line).toBe("What Scout can use doesn't include a computer.");
    expect(text(rendered.action!.props.children)).toBe("Let Scout use the computer");
    (rendered.action!.props.onClick as () => void)();
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout", {
      method: "PATCH", body: JSON.stringify({ toolScope: { deny: ["native:bash"] } }),
    }));
  });

  it("turns on the browser for a Browser dog when it is off for everyone", async () => {
    fixture.config = { features: { browser: false }, browserEngine: { kind: "engine" } };
    const rendered = render(makeBot({ computer: "browser" }));
    (rendered.action!.props.onClick as () => void)();
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: { features: { browser: true } } }));
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PATCH", body: JSON.stringify({ features: { browser: true } }) });
  });

  it("turns on only this dog's browser when only that is off", async () => {
    const rendered = render(makeBot({ computer: "browser", browser: false }));
    (rendered.action!.props.onClick as () => void)();
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "scout", patch: { browser: true } }));
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("shows why a step failed", async () => {
    fixture.api = vi.fn(() => Promise.reject(new Error("Could not save.")));
    const bot = makeBot({ computer: "cloud", toolScope: { deny: ["mcp:computer:*"] } });
    (render(bot).action!.props.onClick as () => void)();
    await vi.waitFor(() => expect(render(bot).html).toContain("Could not save."));
  });
});
