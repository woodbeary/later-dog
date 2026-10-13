// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo, Message } from "@/state/store";
import { StatusActivityRow } from "./StatusActivityRow";

const fixture = vi.hoisted(() => ({
  rest: { since: "2026-10-13T11:00:00Z", until: "2026-10-13T13:00:00Z", estimated: true },
}));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { config: { accountBattery: { resting: { a: fixture.rest } } }, instances: [
    { instanceId: "b", displayName: "Work", driverKind: "codex", snapshot: { state: "available", authenticated: true }, models: { default: "gpt", options: [] } } satisfies InstanceInfo,
  ] } }),
}));
const render = (prefix: string, carry = true) => {
  const host = document.createElement("div");
  const message: Message = { id: "notice", at: Date.now(), role: "bot", kind: "activity", tool: {
    name: `${prefix}: Running on Work`, ok: true, ...(carry ? { carry: { from: "a", to: "b" } } : {}),
  } };
  host.innerHTML = renderToStaticMarkup(createElement(StatusActivityRow, { message }));
  return host;
};
afterEach(() => vi.useRealTimers());

describe("account carry notices", () => {
  it.each(["notice", "recovery"])("shows the actual account handoff for %s arrivals", (prefix) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    const host = render(prefix);
    expect(host.querySelector("[data-account-carry]")).not.toBeNull();
    expect(host.querySelector("[data-sleeping-dog]")).not.toBeNull();
    expect(host.querySelector('[data-recharge="unknown"]')).not.toBeNull();
    expect(host.querySelector("[aria-valuenow]")).toBeNull();
    expect(host.textContent).toBe("Running on Work");
  });
  it("keeps other notices as plain status rows", () => {
    const host = render("notice", false);
    expect(host.querySelector("[data-account-carry]")).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Running on Work");
  });
});
