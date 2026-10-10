import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, TaskUsage } from "@/state/store";

const fixture = vi.hoisted(() => ({ state: null as unknown as AppState }));

vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  return { ...actual, useStore: () => ({ state: fixture.state, dispatch: vi.fn() }) };
});

const { initialState } = await import("@/state/store");
const { setLocale } = await import("@/lib/i18n");
const { UsageSection } = await import("./UsageSection");

const usage = (patch: Partial<TaskUsage>): TaskUsage => ({ input: 1_000, output: 200, costUsd: null, turns: 1, ...patch });
const dog = (name: string, instanceId: string, spent: TaskUsage, patch: Partial<Bot> = {}): Bot => ({
  id: name.toLowerCase(), threadId: `thread-${name.toLowerCase()}`, name, title: "", description: "",
  notifications: false, color: "green", unread: false,
  modelSelection: { instanceId, model: "fixture-model" },
  tasks: [{ threadId: `thread-${name.toLowerCase()}`, title: "Task", createdAt: 0, usage: spent }],
  messages: [],
  ...patch,
});
const engine = (instanceId: string, billing: "metered" | "subscription"): InstanceInfo => ({
  instanceId, driverKind: "claudeAgent", displayName: instanceId,
  snapshot: { state: "available", billing },
  models: { default: "fixture-model", options: [] },
});

const show = (bots: Bot[], instances: InstanceInfo[] = [engine("claude", "subscription")]) => {
  fixture.state = { ...initialState, bots, instances };
  return renderToStaticMarkup(createElement(UsageSection));
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("window", { laterdog: undefined });
  vi.stubGlobal("document", { body: {} });
});
afterEach(() => vi.unstubAllGlobals());

describe("the Usage page", () => {
  it("shows the accounts, then the cost so far, then each dog, then the history, and no budget", () => {
    const html = show([dog("Atlas", "claude", usage({ costUsd: 0.3, turns: 2 }))]);
    const order = ["data-plan-usage", "data-usage-cost", "data-usage-dogs", "data-usage-history"].map((marker) => html.indexOf(marker));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text(html)).not.toMatch(/budget|sell price/i);
  });

  it("adds up what the visible dogs spent, most expensive first", () => {
    const html = show([
      dog("Juniper", "claude", usage({ costUsd: 0.12 })),
      dog("Atlas", "claude", usage({ costUsd: 0.3, turns: 2 })),
      dog("Hidden", "claude", usage({ costUsd: 5 }), { hidden: true }),
      dog("Idle", "claude", usage({ costUsd: 0, turns: 0, input: 0, output: 0 })),
    ]);
    const words = text(html);
    expect(words).toContain("Estimated cost so far $0.42");
    expect(words).toContain("Cost is equivalent — on your subscription, not billed.");
    expect(words.indexOf("Atlas")).toBeLessThan(words.indexOf("Juniper"));
    expect(words).not.toContain("Hidden");
    expect(words).not.toContain("Idle");
    expect(words).toContain("All dogs 3");
  });

  it("says when the dogs run on different kinds of billing", () => {
    const html = show(
      [dog("Atlas", "claude", usage({ costUsd: 0.3 })), dog("Juniper", "openai", usage({ costUsd: 0.1 }))],
      [engine("claude", "subscription"), engine("openai", "metered")],
    );
    expect(text(html)).toContain("Cost is as each provider reports it");
  });

  it("counts tokens when no provider reports a price", () => {
    const words = text(show([dog("Atlas", "claude", usage({ costUsd: null, input: 12_000, output: 400 }))]));
    expect(words).toContain("Estimated cost so far — No price reported yet");
    expect(words).toContain("12.4k");
  });

  it("starts empty, without a table of dogs", () => {
    const html = show([]);
    expect(text(html)).toContain("Estimated cost so far — Nothing spent yet");
    expect(html).not.toContain("data-usage-dogs");
  });
});
