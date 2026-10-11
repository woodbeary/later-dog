import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";

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
    config: {} as { cloudHome?: boolean; box?: { configured: boolean } },
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
  fixture.config = {};
  fixture.instances = [engine()];
  fixture.dispatch = vi.fn();
  fixture.api = vi.fn(() => Promise.resolve({}));
  fixture.ownerOrAdmin = null;
  for (const key of Object.keys(fixture.laterdog)) delete fixture.laterdog[key];
});

describe("Where the dog works", () => {
  it("offers four places in plain names, Auto when nothing is chosen, with Auto's line under them", () => {
    const rendered = render(makeBot());
    expect(rendered.html).toContain("Where Scout works");
    expect(rendered.labels).toEqual(["Auto", "Cloud computer", "This Mac", "Off"]);
    expect(rendered.select.props.value).toBe("auto");
    expect(rendered.line).toBe("Picks its cloud computer or this computer when a task needs one.");
    expect(rendered.action).toBeUndefined();
  });

  it("names only this computer in Auto's line while cloud computers are coming soon", () => {
    fixture.config = { box: { configured: false } };
    expect(render(makeBot()).line).toBe("Uses this computer when a task needs one.");
  });

  it("shows the chosen place and its own line", () => {
    const rendered = render(makeBot({ computer: "local" }));
    expect(rendered.select.props.value).toBe("local");
    expect(rendered.line).not.toBe(render(makeBot()).line);
  });

  it("says This PC off a Mac, and never names a Local VM in Auto's line there", () => {
    fixture.platform = "win32";
    const rendered = render(makeBot());
    expect(rendered.labels).toContain("This PC");
    expect(rendered.line).not.toMatch(/Local VM|Boat|browser|cloud box/i);
  });

  it("leaves out this computer on My Cloud, and says what Auto does there", () => {
    fixture.config = { ...fixture.config, cloudHome: true };
    expect(render(makeBot()).labels).toEqual(["Auto", "Cloud computer", "Off"]);
    expect(render(makeBot()).line).toBe("Starts its cloud computer when a task needs one.");
  });

  it("names a place's problem in a few words and greys it out, with the whole line on hover", () => {
    fixture.instances = [{ ...engine(), displayName: "Plain", capabilities: { computerMcp: false, browserMcp: true } } as InstanceInfo];
    const cloud = render(makeBot()).options.find((node) => node.props.value === "cloud")!;
    expect(text(cloud.props.children)).toBe("Cloud computer · Not with this model");
    expect(cloud.props.disabled).toBe(true);
    expect(cloud.props.title).toBe("M can't use a computer. Choose a model that can, such as Claude or ChatGPT.");
  });

  it("keeps This Mac pickable before macOS grants, which later.dog asks for on first use", () => {
    fixture.localComputer = {
      available: false, support: "unsupported", enabled: false, status: "unavailable", reasonCode: "cua-driver-unavailable",
      message: "Accessibility and Screen Recording required; later.dog asks for them when a dog first uses this Mac",
    } as DesktopCapabilities["localComputer"];
    const local = render(makeBot()).options.find((node) => node.props.value === "local")!;
    expect(local.props.disabled).toBeFalsy();
  });

  it("saves each place as the dog's choice", () => {
    const expected = [{ computer: null }, { computer: "cloud" }, { computer: "local" }, { computer: "off" }];
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

  it("says cloud computers are coming soon when there are none, with no key to add", () => {
    fixture.config = { ...fixture.config, box: { configured: false } };
    const cloud = render(makeBot()).options.find((node) => node.props.value === "cloud")!;
    expect(text(cloud.props.children)).toBe("Cloud computer · Not set up");
    expect(cloud.props.disabled).toBe(true);
    fresh();
    const chosen = render(makeBot({ computer: "cloud" }));
    expect(chosen.line).toBe("Cloud computers aren’t set up here yet.");
    expect(chosen.action).toBeUndefined();
  });

  it("tells a User to ask an Admin to let the dog use the computer", () => {
    fixture.ownerOrAdmin = false;
    const user = render(makeBot({ computer: "cloud", toolScope: { deny: ["mcp:computer:*"] } }));
    expect(user.line).toBe("What Scout can use doesn't include a computer. Ask an Admin to change it.");
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

  it("shows why a step failed", async () => {
    fixture.api = vi.fn(() => Promise.reject(new Error("Could not save.")));
    const bot = makeBot({ computer: "cloud", toolScope: { deny: ["mcp:computer:*"] } });
    (render(bot).action!.props.onClick as () => void)();
    await vi.waitFor(() => expect(render(bot).html).toContain("Could not save."));
  });
});
