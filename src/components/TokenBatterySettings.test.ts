import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus, InstanceInfo } from "@/state/store";
import { TokenBatterySettings, accountState, batteryRows, makeFavourite, moveAccount } from "./TokenBatterySettings";
import { Switch } from "./SettingsPrimitives";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0,
  config: {} as Pick<ConfigStatus, "accountBattery">,
  instances: [] as InstanceInfo[],
  api: vi.fn(), dispatch: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    return fixture.values[index] ??= { current: initial };
  },
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config, instances: fixture.instances }, dispatch: fixture.dispatch }),
}));

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function render() {
  let tree: ReactNode = null;
  function Capture() { fixture.index = 0; tree = TokenBatterySettings(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  const button = (label: string) => all.find((node) => node.type === "button" && node.props["aria-label"] === label);
  return {
    html,
    all,
    toggle: all.find((node) => node.type === Switch)!,
    button,
    save: all.filter((node) => node.type === "button").at(-1)!,
    names: all.filter((node) => node.type === "li").map((node) => nodes(node.props.children)
      .find((child) => typeof child.props.children === "string" && String(child.props.className).includes("truncate text-[13px]"))?.props.children),
  };
}
const click = (node: Node | undefined) => (node!.props.onClick as () => void)();
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

const HOUR = 60 * 60 * 1000;
const account = (instanceId: string, displayName: string, extra: Partial<InstanceInfo["snapshot"]> = {}): InstanceInfo => ({
  instanceId, driverKind: "claudeAgent", displayName,
  snapshot: { state: "available", authenticated: true, ...extra },
  models: { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }] },
  claudeAccount: { configDir: `/fixture/${instanceId}`, signInCommand: "claude auth login", signInShell: "sh", isDefault: instanceId === "claude" },
});

beforeEach(() => {
  fixture.values = [];
  fixture.instances = [
    account("claude", "Personal", { account: { email: "me@example.test" } }),
    account("claude-work", "Work", { account: { email: "work@example.test" } }),
    account("claude-spare", "Spare", { authenticated: false }),
  ];
  fixture.config = {
    accountBattery: {
      enabled: false,
      order: { claudeAgent: ["claude", "claude-work", "claude-spare"] },
      resting: { "claude-work": { until: new Date(Date.now() + 2 * HOUR).toISOString(), kind: "session" } },
    },
  };
  fixture.api.mockReset();
  fixture.dispatch.mockReset().mockImplementation(({ config }: { config: ConfigStatus }) => { fixture.config = config; });
});

describe("token battery ordering", () => {
  it("moves an account one place and makes another the favourite without losing any", () => {
    const order = ["a", "b", "c"];
    expect(moveAccount(order, "c", -1)).toEqual(["a", "c", "b"]);
    expect(moveAccount(order, "a", 1)).toEqual(["b", "a", "c"]);
    expect(moveAccount(order, "a", -1)).toEqual(order);
    expect(moveAccount(order, "c", 1)).toEqual(order);
    expect(moveAccount(order, "missing", 1)).toEqual(order);
    expect(makeFavourite(order, "c")).toEqual(["c", "a", "b"]);
    expect(makeFavourite(order, "missing")).toEqual(order);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("reads each account as ready, resting until its reset, or not signed in", () => {
    const now = Date.now();
    const [personal, work, spare] = fixture.instances;
    expect(accountState(personal!, undefined, now)).toEqual({ kind: "ready" });
    expect(accountState(work!, { until: new Date(now + HOUR).toISOString() }, now)).toEqual({ kind: "resting", until: new Date(now + HOUR).toISOString() });
    // a rest whose reset has passed is over
    expect(accountState(work!, { until: new Date(now - 1).toISOString() }, now)).toEqual({ kind: "ready" });
    expect(accountState(spare!, undefined, now)).toEqual({ kind: "signedOut" });
  });

  it("flags a later account signed in to the same login, which shares its limit", () => {
    const twin = account("claude-twin", "Twin folder", { account: { email: "ME@example.test" } });
    const rows = batteryRows(["claude", "claude-twin", "gone"], undefined, [...fixture.instances, twin], Date.now());
    expect(rows.map((row) => row.instance.instanceId)).toEqual(["claude", "claude-twin"]);
    expect(rows[1]!.sameLoginAs).toBe("Personal");
    expect(rows[0]!.sameLoginAs).toBeUndefined();
  });
});

describe("TokenBatterySettings", () => {
  it("starts off, lists the order with the favourite first and each account's state, and states the terms", () => {
    const view = render();
    expect(view.toggle.props.checked).toBe(false);
    expect(view.names).toEqual(["Personal", "Work", "Spare"]);
    expect(view.html).toContain('aria-label="Favourite"');
    expect(view.html).toContain("Ready");
    expect(view.html).toMatch(/Resting until [^<]*\d{1,2}:\d{2}/);
    expect(view.html).toContain("Not signed in");
    expect(view.html).toContain("Nothing changes until you switch this on.");
    expect(view.html).toContain("choice under each provider");
    expect(view.html).toContain("approvals given for one session stay behind");
    expect(view.button("Move Personal up")!.props.disabled).toBe(true);
    expect(view.button("Move Spare down")!.props.disabled).toBe(true);
    expect(view.save.props.disabled).toBe(true);
  });

  it("reorders, picks a favourite and saves the whole order once", async () => {
    click(render().button("Move Spare up"));
    expect(render().names).toEqual(["Personal", "Spare", "Work"]);
    click(render().button("Make Work your favourite"));
    expect(render().names).toEqual(["Work", "Personal", "Spare"]);
    click(render().toggle);
    expect(render().toggle.props.checked).toBe(true);
    let resolve!: (config: Pick<ConfigStatus, "accountBattery">) => void;
    fixture.api.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    click(render().save);
    click(render().save);
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(fixture.api).toHaveBeenCalledWith("/api/config", {
      method: "PUT",
      body: JSON.stringify({ accountBattery: { enabled: true, order: { claudeAgent: ["claude-work", "claude", "claude-spare"], codex: [] } } }),
    });
    resolve({ accountBattery: { enabled: true, order: { claudeAgent: ["claude-work", "claude", "claude-spare"] } } });
    await flush();
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    const saved = render();
    expect(saved.names).toEqual(["Work", "Personal", "Spare"]);
    expect(saved.toggle.props.checked).toBe(true);
    expect(saved.save.props.disabled).toBe(true);
  });

  it("keeps the draft and shows the server's refusal when a save fails", async () => {
    click(render().button("Move Work down"));
    fixture.api.mockRejectedValueOnce(new Error("Fixture refusal"));
    click(render().save);
    await flush();
    const view = render();
    expect(view.html).toContain('role="alert"');
    expect(view.html).toContain("Fixture refusal");
    expect(view.names).toEqual(["Personal", "Spare", "Work"]);
    expect(view.save.props.disabled).toBe(false);
  });

  it("asks for a second account when there is only one", () => {
    fixture.config = { accountBattery: { enabled: false, order: { claudeAgent: ["claude"] } } };
    const view = render();
    expect(view.names).toEqual(["Personal"]);
    expect(view.html).toContain("Add a second Claude account above");
  });

  it("lists Codex accounts apart from Claude's, reorders each on its own, and saves both", async () => {
    const codex = (instanceId: string, displayName: string, email: string): InstanceInfo => ({
      ...account(instanceId, displayName, { account: { email } }), driverKind: "codex", claudeAccount: undefined,
    });
    fixture.instances = [...fixture.instances, codex("chatgpt", "ChatGPT", "me@example.test"), codex("chatgpt-work", "ChatGPT work", "work@example.test")];
    fixture.config = { accountBattery: { enabled: true, order: { claudeAgent: ["claude", "claude-work"], codex: ["chatgpt", "chatgpt-work"] } } };
    const view = render();
    expect(view.names).toEqual(["Personal", "Work", "ChatGPT", "ChatGPT work"]);
    expect(view.html).toContain(">Claude<");
    expect(view.html).toContain(">Codex<");
    click(view.button("Make ChatGPT work your favourite"));
    expect(render().names).toEqual(["Personal", "Work", "ChatGPT work", "ChatGPT"]);
    fixture.api.mockResolvedValueOnce({ accountBattery: { enabled: true, order: { claudeAgent: ["claude", "claude-work"], codex: ["chatgpt-work", "chatgpt"] } } });
    click(render().save);
    await flush();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", {
      method: "PUT",
      body: JSON.stringify({ accountBattery: { enabled: true, order: { claudeAgent: ["claude", "claude-work"], codex: ["chatgpt-work", "chatgpt"] } } }),
    });
  });

  it("asks for a second ChatGPT account when Codex has one", () => {
    fixture.instances = [...fixture.instances, { ...account("chatgpt", "ChatGPT"), driverKind: "codex", claudeAccount: undefined }];
    fixture.config = { accountBattery: { enabled: false, order: { claudeAgent: ["claude", "claude-work"], codex: ["chatgpt"] } } };
    expect(render().html).toContain("Add a second ChatGPT account above");
  });
});

