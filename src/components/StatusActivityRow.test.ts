// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo, Message } from "@/state/store";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { StatusActivityRow } from "./StatusActivityRow";

const fixture = vi.hoisted(() => ({
  rest: { since: "2026-10-13T11:00:00Z", until: "2026-10-13T13:00:00Z", estimated: true },
  api: vi.fn(async (_path: string, _init?: { method?: string }) => ({ ok: true })),
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
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

describe("a dog's status line while it works", () => {
  it("reads as a plain status row in the same style as other notices, marked as progress", () => {
    const message: Message = { id: "still", at: Date.now(), role: "bot", kind: "activity", tool: {
      name: "notice: Still on it: running the tests", ok: true, statusLine: "live", spoken: "running the tests",
    } };
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(StatusActivityRow, { message }));
    const row = host.querySelector('[role="status"]');
    expect(row?.textContent).toBe("Still on it: running the tests");
    expect(row?.hasAttribute("data-status-line")).toBe(true);
    expect(row?.className).toContain("bg-panel");
    expect(render("notice", false).querySelector("[data-status-line]")).toBeNull();
  });
});

describe("Continue after time runs out", () => {
  const offer: Message = { id: "offer", at: Date.now(), role: "bot", kind: "activity", tool: {
    name: "notice: Ran out of time after 4 hours. Continue?", ok: true, resume: { handoffId: "root-1" },
  } };
  it("says what happened in plain words and offers one Continue button", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(StatusActivityRow, { message: offer }));
    expect(host.querySelector("[data-continue-work]")?.textContent).toBe("Ran out of time after 4 hours.Continue");
    expect(host.querySelectorAll("[data-continue-work-button]")).toHaveLength(1);
    expect(host.textContent).not.toMatch(/stopped by user|the user/i);
  });
  it("asks the server to resume the same work, and shows its refusal if it cannot", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(createElement(StatusActivityRow, { message: offer })); });
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-continue-work-button]")!.click(); });
    expect(fixture.api).toHaveBeenCalledWith("/api/handoffs/root-1/continue", { method: "POST" });
    fixture.api.mockRejectedValueOnce(new Error("This work was already continued."));
    await act(async () => { root.render(createElement(StatusActivityRow, { key: "again", message: { ...offer, id: "offer-2" } })); });
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-continue-work-button]")!.click(); });
    expect(host.querySelector("[data-continue-work-error]")?.textContent).toBe("This work was already continued.");
    await act(async () => { root.unmount(); });
    host.remove();
  });
});
