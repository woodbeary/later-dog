// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { AccountMenu } from "./AccountMenu";
import type { PlanProvider } from "./PlanUsage";
const now = Date.parse("2026-10-13T12:00:00Z");
const instance = (instanceId: string): InstanceInfo => ({ instanceId, displayName: instanceId, driverKind: "claudeAgent", snapshot: { state: "available", authenticated: true }, models: { default: "opus", options: [] } });
const provider: PlanProvider = { id: "a", name: "a", driver: "claude", plan: null, ok: true, error: null, extra: [], fiveHour: { available: true, usedPercent: 16, remainingPercent: 84, resetsAt: null }, weekly: { available: true, usedPercent: 27, remainingPercent: 73, resetsAt: null } };
const rest = { since: new Date(now - 3_600_000).toISOString(), until: new Date(now + 3_600_000).toISOString() };
function render(auto = false, used = 27) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(AccountMenu, { auto, now, onPick: vi.fn(), onReorder: vi.fn(), rows: [
    { instance: instance("a"), label: "Personal", selected: true, movable: true, rest },
    { instance: instance("b"), label: "Work", selected: false, movable: true, inUse: true, provider: { ...provider, weekly: { ...provider.weekly, usedPercent: used, remainingPercent: 100 - used } } },
  ] }));
  return host;
}
describe("compact account batteries", () => {
  it("replaces the resting provider mark with a dog and a filling battery", () => {
    const row = render().querySelector('[data-account-row="a"]')!;
    expect(row.firstElementChild?.firstElementChild?.hasAttribute("data-sleeping-dog")).toBe(true);
    expect(row.querySelector('[data-recharge="50"]')).not.toBeNull();
    expect(row.textContent).toContain("Back at");
    expect(row.querySelector("[data-account-grip]")?.className).not.toContain("opacity-0");
  });
  it("shows the tighter remaining window and identifies the account actually in use", () => {
    const row = render().querySelector('[data-account-row="b"]')!;
    expect(row.textContent).toContain("73% left");
    expect(row.querySelector("[data-account-in-use]")?.textContent).toBe("In use now");
  });
  it("sleeps at a verified full limit without a fabricated recharge estimate", () => {
    const row = render(false, 100).querySelector('[data-account-row="b"]')!;
    expect(row.querySelector("[data-sleeping-dog]")).not.toBeNull();
    expect(row.textContent).toContain("0% left");
    expect(row.querySelector("[data-recharge]")).toBeNull();
    expect(render(false, 99.6).querySelector('[data-account-row="b"] [data-sleeping-dog]')).toBeNull();
  });
  it("locks dragging while the server manages priority", () => {
    const host = render(true);
    expect(host.querySelector("[data-account-managed]")?.textContent).toContain("Automatically managed");
    expect(host.querySelector("[data-account-grip]")).toBeNull();
    expect(host.querySelector("[draggable]")).toBeNull();
  });
});
