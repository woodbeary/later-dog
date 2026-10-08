import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], dispatch: null as any }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? initial() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: {}, dispatch: f.dispatch }) }));
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { ProSettingsCard } from "./ProIntroduction";

const signedOut = { status: "signed-out" } as const;
beforeEach(() => {
  f.index = 0; f.values = []; f.effects = []; f.dispatch = vi.fn();
  vi.stubGlobal("window", { laterdog: { cloudAccount: { state: () => Promise.resolve(signedOut), onState: () => () => {} } } });
});
afterEach(() => vi.unstubAllGlobals());

const card = (state: CloudAccountState | null) => { f.values = [state]; f.index = 0; f.effects = []; return renderToStaticMarkup(createElement(ProSettingsCard)); };
const plan = (extra: Partial<CloudAccountState> = {}): CloudAccountState => ({ status: "connected", account: { id: "a", email: "person@example.test" },
  entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 }, ...extra });
const paid = (tier?: string, status: "active" | "inactive" = "active") => ({ plan: "pro" as const, ...(tier ? { tier } : {}), status, expiresAt: status === "active" ? 1_900_000_000_000 : null, version: 2 });
const SELLING = ["Get Pro", "See all plans", "$29", "$49", "$89", "$99", "/month", "Already have a Cloud plan?", "apple.com", "laterdog"];

it("sells nothing: signed out, free, or not yet known shows no offer, price or store link", () => {
  for (const state of [null, signedOut, { status: "signed-out", message: "restoring" }, { status: "connecting" }, plan(), { status: "unavailable" }] as Array<CloudAccountState | null>) {
    expect(card(state), JSON.stringify(state)).toBe("");
  }
});

it("renders nothing without a Cloud bridge (a browser, a remote page, a build with no Cloud)", () => {
  vi.stubGlobal("window", { laterdog: {} });
  expect(card(plan({ entitlement: paid("max") }))).toBe("");
  vi.stubGlobal("window", { laterdog: { cloudAccount: { state: () => Promise.resolve(signedOut), onState: () => () => {} }, remoteClient: { active: true } } });
  expect(card(plan({ entitlement: paid("max") }))).toBe("");
});

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
const nodes = (value: ReactNode): Node[] => !isValidElement(value) ? [] : [value as Node, ...Children.toArray((value as Node).props.children).flatMap(nodes)];
it("in Settings, someone with a plan sees that plan and the way to it, never an offer", () => {
  for (const [state, text] of [
    [plan({ entitlement: paid("max") }), "Max active · verified by later.dog Cloud"],
    [plan({ entitlement: paid("pro", "inactive") }), "Pro · not active right now"],
    [plan({ purchase: { state: "confirming", tier: "personal" } }), "Personal · payment received"],
    [{ status: "unavailable", lastPlan: { tier: "personal", active: true } }, "Personal · checking with later.dog Cloud…"],
    [{ status: "reauth-required", message: "expired", lastPlan: { tier: "max", active: true } }, "Sign in again to use My Cloud on this computer"],
  ] as const) {
    const html = card(state as CloudAccountState);
    expect(html).toContain(text); expect(html).toContain("later.dog Cloud settings");
    for (const gone of SELLING) expect(html, gone).not.toContain(gone);
  }
  f.values = [plan({ entitlement: paid("max") })]; f.index = 0;
  let tree: ReactNode; function Capture() { tree = ProSettingsCard(); return tree; } renderToStaticMarkup(createElement(Capture));
  nodes(tree).find(node => node.type === "button" && node.props.children === "later.dog Cloud settings")!.props.onClick!();
  expect(f.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "cloudAccount" });
});
