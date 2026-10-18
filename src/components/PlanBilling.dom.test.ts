// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ cloudHome: false }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { config: { cloudHome: fixture.cloudHome } }, dispatch: vi.fn() }),
}));
vi.mock("./CloudTrial", () => ({ CloudTrialRow: () => createElement("div", { "data-trial-row": "" }) }));

const { PlanBilling } = await import("./PlanBilling");

const account = { id: "user-1", email: "jo@example.test" };
const paid: CloudAccountState = { status: "connected", account, entitlement: { plan: "pro", tier: "personal", status: "active", expiresAt: 1_900_000_000_000, version: 1 }, machine: { status: "ready", origin: "https://h1-home.later.dog" } };

let host: HTMLDivElement;
let root: Root;
const text = () => host.textContent ?? "";
const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label);

async function show(laterdog: Record<string, unknown>) {
  (window as unknown as { laterdog?: unknown }).laterdog = laterdog;
  await act(async () => { root.render(createElement(PlanBilling)); });
  await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
}

function thisMac(state: CloudAccountState) {
  return { state: vi.fn(async () => state), onState: vi.fn(() => () => {}), openDashboard: vi.fn(async () => state) };
}

beforeEach(() => {
  setLocale("en");
  fixture.cloudHome = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as { laterdog?: unknown }).laterdog;
});

describe("Usage & Billing, the plan row", () => {
  it("names the plan, says billing is on later.dog, and Manage opens it in the browser from this Mac's window", async () => {
    const cloudAccount = thisMac(paid);
    await show({ cloudAccount });
    const row = host.querySelector("[data-plan-row]");
    expect(row?.getAttribute("data-plan-row")).toBe("paid");
    expect(row?.textContent).toContain("later.dog Cloud");
    expect(row?.textContent).toContain("Billing is on later.dog. Manage opens it in your browser.");
    await act(async () => { button("Manage")!.click(); });
    expect(cloudAccount.openDashboard).toHaveBeenCalledOnce();
  });

  it("shows the same row in the Cloud's window, where Manage goes through the app", async () => {
    fixture.cloudHome = true;
    const cloudPlan = { state: vi.fn(async () => ({ status: "attention" as const, tier: "personal", email: "jo@example.test" })), manage: vi.fn(async () => {}), signOut: vi.fn() };
    await show({ cloudPlan });
    expect(host.querySelector("[data-plan-row]")?.getAttribute("data-plan-row")).toBe("inactive");
    expect(text()).toContain("Your later.dog Cloud plan isn't active right now.");
    expect(text()).toContain("Billing is on later.dog. Manage opens it in your browser.");
    await act(async () => { button("Manage")!.click(); });
    expect(cloudPlan.manage).toHaveBeenCalledOnce();
    expect(cloudPlan.signOut).not.toHaveBeenCalled();
    expect(host.querySelector("[data-trial-row]"), "a home's key is not a trial to end or buy").toBeNull();
  });

  it("never reads as a paid plan when the Cloud's window knows of no plan", async () => {
    fixture.cloudHome = true;
    await show({ cloudPlan: { state: vi.fn(async () => ({ status: "none" as const, email: "jo@example.test" })), manage: vi.fn(async () => {}), signOut: vi.fn() } });
    const row = host.querySelector("[data-plan-row]");
    expect(row?.getAttribute("data-plan-row")).toBe("inactive");
    expect(row?.textContent).toContain("Your later.dog Cloud plan isn't active right now.");
    expect(row?.textContent).not.toMatch(/later\.dog Cloud(?! plan)/);
  });

  it("says so when Manage can't open the page", async () => {
    const cloudPlan = { state: vi.fn(async () => ({ status: "paid" as const })), manage: vi.fn(async () => { throw new Error("Choose Manage"); }), signOut: vi.fn() };
    await show({ cloudPlan });
    await act(async () => { button("Manage")!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector("[role=alert]")?.textContent).toBe("That didn't work. Check your connection and try again.");
  });

  it("has no plan row when signed out or in a plain browser, and keeps the Mac's free trial row here", async () => {
    await show({ cloudAccount: thisMac({ status: "signed-out" }) });
    expect(host.querySelector("[data-plan-row]")).toBeNull();
    expect(host.querySelector("[data-trial-row]")).not.toBeNull();
    await show({});
    expect(host.querySelector("[data-plan-row]")).toBeNull();
    expect(host.querySelector("[data-trial-row]")).not.toBeNull();
  });
});
