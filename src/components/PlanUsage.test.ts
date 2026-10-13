import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ api: vi.fn() }));
import { AccountUsage, keepLastGood, resetDistance, type PlanProvider } from "./PlanUsage";

const HOUR = 60 * 60 * 1000;
const provider = (overrides: Partial<PlanProvider> = {}): PlanProvider => ({
  id: "fixture", name: "Fixture provider", driver: "claude", plan: "Pro", ok: true, error: null,
  fiveHour: { available: true, remainingPercent: 68, usedPercent: 32, resetsAt: new Date(Date.now() + 2 * HOUR + 10 * 60_000).toISOString() },
  weekly: { available: true, remainingPercent: 30, usedPercent: 70, resetsAt: new Date(Date.now() + 3 * 24 * HOUR + 4 * HOUR).toISOString() },
  extra: [], models: [],
  ...overrides,
});

describe("reset distance", () => {
  it("counts down in days, hours and minutes through the catalog", () => {
    const now = Date.parse("2026-10-08T12:00:00Z");
    const at = (ms: number) => new Date(now + ms).toISOString();
    expect(resetDistance(at(30_000), now)).toBe("less than a minute");
    expect(resetDistance(at(25 * 60_000), now)).toBe("25m");
    expect(resetDistance(at(2 * HOUR + 10 * 60_000), now)).toBe("2h 10m");
    expect(resetDistance(at(3 * HOUR), now)).toBe("3h");
    expect(resetDistance(at(3 * 24 * HOUR + 4 * HOUR), now)).toBe("3d 4h");
    expect(resetDistance(at(2 * 24 * HOUR), now)).toBe("2d");
    expect(resetDistance(at(-1), now)).toBeNull();
    expect(resetDistance(null, now)).toBeNull();
  });
});

describe("Account usage presentation", () => {
  it("shows each window as a bar that fills as it is used, warming as it runs low, with what is left and its reset", () => {
    const html = renderToStaticMarkup(createElement(AccountUsage, { provider: provider(), now: Date.now() }));
    expect(html.match(/role="meter"/g)).toHaveLength(2);
    expect(html).toContain('aria-valuenow="32"');
    expect(html).toContain('aria-valuenow="70"');
    expect(html).toContain("5-hour · 68% left · resets in 2h 10m");
    expect(html).toContain("Weekly · 30% left · resets in 3d 4h");
    expect(html).not.toContain("% used");
    expect(html).toContain("bg-success");
    expect(html).toContain("bg-caution");
    expect(html).not.toContain("bg-danger");
  });

  it("turns the bar to danger when less than a tenth is left, and leaves out a window that is not reported", () => {
    const hot = provider({ fiveHour: { available: true, remainingPercent: 5, usedPercent: 95, resetsAt: null }, weekly: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null } });
    const html = renderToStaticMarkup(createElement(AccountUsage, { provider: hot, now: Date.now() }));
    expect(html).toContain("bg-danger");
    expect(html).toContain("5-hour · 5% left");
    expect(html).not.toContain("Weekly");
  });

  it("puts a resting account to sleep with a line that recharges until it is back, and shows nothing when there is nothing real to report", () => {
    const now = Date.now();
    const rest = { since: new Date(now - HOUR).toISOString(), until: new Date(now + HOUR).toISOString() };
    const resting = renderToStaticMarkup(createElement(AccountUsage, { provider: provider(), now, resting: rest }));
    expect(resting).toContain("Recharging");
    expect(resting).toMatch(/Back at [^<]*\d{1,2}:\d{2}[^<]* · in 1h</);
    expect(resting).toContain('data-sleeping-dog=""');
    expect(resting).toContain('data-recharge="50"');
    expect(resting).toContain('aria-valuetext="50% recharged"');
    expect(resting).not.toContain('role="meter"');
    const rough = renderToStaticMarkup(createElement(AccountUsage, { provider: provider(), now, resting: { until: rest.until, estimated: true } }));
    expect(rough).toMatch(/Back around [^<]*\d{1,2}:\d{2}[^<]*</);
    expect(rough).not.toContain(" · in ");
    expect(rough).toContain('data-recharge="unknown"');
    const over = renderToStaticMarkup(createElement(AccountUsage, { provider: provider(), now, resting: { ...rest, until: new Date(now - 1).toISOString() } }));
    expect(over).not.toContain("Recharging");
    expect(over).toContain('role="meter"');
    const none = renderToStaticMarkup(createElement(AccountUsage, { provider: undefined, now: Date.now() }));
    expect(none).toBe("");
    const failed = renderToStaticMarkup(createElement(AccountUsage, { provider: provider({ ok: false, error: "Could not reach Claude" }), now: Date.now() }));
    expect(failed).toBe("");
  });

  it("never tells a signed-in account to sign in again, and never names Codex", () => {
    for (const error of ["Sign in again in Claude", "Sign in again in Codex", "Could not reach Codex", "Codex returned an unexpected usage response"]) {
      const html = renderToStaticMarkup(createElement(AccountUsage, { provider: provider({ ok: false, error }), now: Date.now() }));
      expect(html).toBe("");
    }
  });
});

describe("Keeping the last good reading", () => {
  it("keeps an account's last reading through a failed check for ten minutes", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    const good = provider({ id: "work" });
    const failed = provider({ id: "work", ok: false, error: "Could not reach Claude." });
    const fresh = keepLastGood({ fetchedAt: "", providers: [failed] }, new Map([["work", { provider: good, at: now - 9 * 60_000 }]]), now);
    expect(fresh.providers[0]).toBe(good);
    const stale = keepLastGood({ fetchedAt: "", providers: [failed] }, new Map([["work", { provider: good, at: now - 11 * 60_000 }]]), now);
    expect(stale.providers[0]).toBe(failed);
  });

  it("always shows a new good reading", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    const next = provider({ id: "work", fiveHour: { available: true, remainingPercent: 10, usedPercent: 90, resetsAt: null } });
    const merged = keepLastGood({ fetchedAt: "", providers: [next] }, new Map([["work", { provider: provider({ id: "work" }), at: now }]]), now);
    expect(merged.providers[0]).toBe(next);
  });
});
