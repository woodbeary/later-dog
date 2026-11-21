// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceApprovalCardData } from "../../shared/device-approval";
import type { Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ api: vi.fn(), open: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api }));
vi.mock("@/lib/app-links", () => ({ openExternalLink: fixture.open }));
import { DeviceApprovalCard, deviceApprovalCountdown } from "./DeviceApprovalCard";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const approval = (patch: Partial<DeviceApprovalCardData> = {}): DeviceApprovalCardData => ({
  version: 1,
  service: "Cloudflare",
  url: "https://dash.cloudflare.com/oauth2/device/verify",
  code: "h3djWkhR",
  expiresAt: NOW + 5 * 60_000,
  status: "waiting",
  watching: "expiry",
  ...patch,
});
const message = (deviceApproval: DeviceApprovalCardData): Message => ({
  id: "card-1", role: "bot", kind: "options", at: 0,
  card: { title: "Approve Cloudflare sign-in", subtitle: "Cloudflare", options: [], deviceApproval },
});

let host: HTMLDivElement;
let root: Root;
const mount = (card: DeviceApprovalCardData) => act(() => root.render(createElement(DeviceApprovalCard, { botId: "bot-1", threadId: "thread-1", message: message(card) })));
const text = () => host.textContent?.replace(/\s+/g, " ").trim() ?? "";
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
const state = () => host.querySelector("[data-device-approval]")?.getAttribute("data-device-approval");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  fixture.api.mockReset();
  fixture.open.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the desktop device sign-in card", () => {
  it("shows the code, a live countdown, Open, Approved and Dismiss while it waits", () => {
    mount(approval());
    expect(state()).toBe("waiting");
    expect(text()).toContain("Approve Cloudflare sign-in");
    expect(text()).toContain("Copy the code, open the page, and paste it there.");
    expect(host.querySelector("[data-device-code]")?.textContent).toBe("h3djWkhR");
    expect(text()).toContain("5:00 left");
    act(() => { vi.advanceTimersByTime(61_000); });
    expect(text()).toContain("3:59 left");
    expect(button("Get a new code")).toBeUndefined();
    act(() => button("Open")!.click());
    expect(fixture.open).toHaveBeenCalledWith("https://dash.cloudflare.com/oauth2/device/verify");
    expect(button("Approved")).toBeDefined();
    expect(button("Dismiss")).toBeDefined();
  });

  it("offers Get a new code once the code ran out unused, and asks the renew route for it", async () => {
    fixture.api.mockResolvedValue({ card: approval({ status: "expired", endedBy: "expiry", renew: "asked" }) });
    mount(approval({ status: "expired", endedBy: "expiry", renew: "offered" }));
    expect(state()).toBe("expired");
    expect(text()).toContain("Code expired");
    expect(text()).toContain("This code ran out before it was used. Get a new one when you're ready.");
    expect(host.querySelector("[data-device-code]")).toBeNull();
    expect(button("Open")).toBeUndefined();
    expect(button("Approved")).toBeUndefined();
    await act(async () => button("Get a new code")!.click());
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/bot-1/device-approvals/card-1/renew", { method: "POST", body: JSON.stringify({ threadId: "thread-1" }) });
  });

  it("shows Getting a new code after the person asked, with no second button", () => {
    mount(approval({ status: "expired", endedBy: "expiry", renew: "asked" }));
    expect(state()).toBe("renewing");
    expect(text()).toContain("Getting a new code");
    expect(button("Get a new code")).toBeUndefined();
    expect(text()).not.toContain("ran out before it was used");
  });

  it("says when getting a new code did not go through and lets the person try again", async () => {
    fixture.api.mockRejectedValue(new Error("409"));
    mount(approval({ status: "expired", endedBy: "expiry", renew: "offered" }));
    await act(async () => button("Get a new code")!.click());
    expect(host.querySelector("[role=alert]")?.textContent).toBe("That didn't go through. Try again.");
    expect(button("Get a new code")?.disabled).toBe(false);
  });

  it("does not offer a new code for a card that expired some other way or was replaced, dismissed or approved", () => {
    mount(approval({ status: "expired", endedBy: "expiry" }));
    expect(button("Get a new code")).toBeUndefined();
    mount(approval({ status: "ended", endedBy: "replaced" }));
    expect(text()).toContain("Replaced by a newer code");
    mount(approval({ status: "ended", endedBy: "dismissed" }));
    expect(text()).toContain("Dismissed");
    mount(approval({ status: "approved", endedBy: "person" }));
    expect(text()).toContain("Signed in");
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  it("shows Code expired as soon as a waiting code's time runs out, before the server says so", () => {
    mount(approval({ expiresAt: NOW + 2_000 }));
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(state()).toBe("expired");
    expect(text()).toContain("Code expired");
    expect(button("Open")).toBeUndefined();
  });
});

describe("deviceApprovalCountdown", () => {
  it("counts minutes and seconds, then hours", () => {
    expect(deviceApprovalCountdown(NOW + 65_000, NOW)).toBe("1:05");
    expect(deviceApprovalCountdown(NOW - 1, NOW)).toBe("0:00");
    expect(deviceApprovalCountdown(NOW + 2 * 3_600_000 + 5 * 60_000, NOW)).toBe("2h 5m");
  });
});
