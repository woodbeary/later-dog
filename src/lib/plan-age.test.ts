import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DogPlan } from "@/components/PlanChecklist";
import { planOutOfDate } from "./plan-age";

const MINUTE = 60_000;
const CHANGED = new Date(2026, 10, 14, 8, 30).getTime();
const open = { updatedAt: CHANGED, items: [{ text: "Write the notes", status: "done" as const }, { text: "Check the export", status: "in_progress" as const }] };
const finished = { updatedAt: CHANGED, items: open.items.map((item) => ({ ...item, status: "done" as const })) };

afterEach(() => vi.useRealTimers());

describe("a plan that may be out of date", () => {
  it("says so while the dog works, with steps left and ten minutes on the clock since it last changed", () => {
    expect(planOutOfDate(open, CHANGED + 2 * MINUTE, CHANGED + 12 * MINUTE)).toBe(true);
    expect(planOutOfDate(open, CHANGED - 5 * MINUTE, CHANGED + 15 * MINUTE)).toBe(true);
    expect(planOutOfDate(open, CHANGED - 5 * MINUTE, CHANGED + 9 * MINUTE)).toBe(false);
    expect(planOutOfDate(finished, CHANGED + MINUTE, CHANGED + 30 * MINUTE)).toBe(false);
    expect(planOutOfDate(open, null, CHANGED + 30 * MINUTE)).toBe(false);
    expect(planOutOfDate({ ...open, updatedAt: Number.NaN }, CHANGED, CHANGED + 30 * MINUTE)).toBe(false);
  });

  it("flags a plan written early in one long turn once the clock passes ten minutes, and spins on no step then", () => {
    vi.useFakeTimers();
    vi.setSystemTime(CHANGED + 15 * MINUTE);
    const stale = renderToStaticMarkup(createElement(DogPlan, { plan: open, working: true, since: CHANGED - MINUTE }));
    expect(stale).toContain("Plan from 8:30");
    expect(stale).toContain("may be out of date");
    expect(stale).not.toContain("animate-spin");
    vi.setSystemTime(CHANGED + 5 * MINUTE);
    const fresh = renderToStaticMarkup(createElement(DogPlan, { plan: open, working: true, since: CHANGED - MINUTE }));
    expect(fresh).not.toContain("may be out of date");
    expect(fresh).toContain("animate-spin");
  });
});
