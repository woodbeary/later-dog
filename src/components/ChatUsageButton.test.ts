// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanProvider } from "./PlanUsage";

vi.mock("@/state/store", () => ({ api: vi.fn() }));

const { ChatUsageButton } = await import("./ChatUsageButton");
const { chatContextReading } = await import("@/lib/chat-context");

const account = (weekly: number, fiveHour = 0): PlanProvider => ({
  id: "claude", name: "Claude", driver: "claudeAgent", plan: "max", ok: true, error: null, extra: [],
  weekly: { available: true, usedPercent: weekly, remainingPercent: 100 - weekly, resetsAt: null },
  fiveHour: { available: true, usedPercent: fiveHour, remainingPercent: 100 - fiveHour, resetsAt: null },
});

let host: HTMLDivElement;
let root: Root;
const render = async (provider: PlanProvider, resting?: { until: string }, reading = chatContextReading({ tokens: 10_000, window: 200_000 })) => {
  await act(async () => root.render(createElement(ChatUsageButton, {
    mark: "M", title: "Usage", reading, threadId: "t", accountName: null, provider, resting, now: 0, onOpen: () => {}, onSeeAll: () => {},
  })));
  return host.querySelector("[data-chat-usage]");
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the composer's usage ring", () => {
  it("stays hidden while the account is under 75 %", async () => {
    expect(await render(account(74, 60))).toBeNull();
  });

  it("shows from 75 % of either window", async () => {
    expect(await render(account(75))).not.toBeNull();
    expect(await render(account(10, 80))).not.toBeNull();
  });

  it("shows while the account rests or the chat's context is nearly full", async () => {
    expect(await render(account(10), { until: "2026-11-17T15:00:00Z" })).not.toBeNull();
    expect(await render(account(10), undefined, chatContextReading({ tokens: 160_000, window: 200_000 }))).not.toBeNull();
  });
});
