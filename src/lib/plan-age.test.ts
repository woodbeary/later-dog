import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { DogPlan } from "@/components/PlanChecklist";
import { latestWorkAt, planOutOfDate } from "./plan-age";

const MINUTE = 60_000;
const CHANGED = new Date(2026, 10, 14, 8, 30).getTime();
const open = { updatedAt: CHANGED, items: [{ text: "Write the notes", status: "done" as const }, { text: "Check the export", status: "in_progress" as const }] };
const finished = { updatedAt: CHANGED, items: open.items.map((item) => ({ ...item, status: "done" as const })) };

describe("a plan that may be out of date", () => {
  it("says so only with steps left, a turn that began after it changed, and ten minutes since", () => {
    expect(planOutOfDate(open, CHANGED + 12 * MINUTE, null)).toBe(true);
    expect(planOutOfDate(open, CHANGED + 2 * MINUTE, CHANGED + 11 * MINUTE)).toBe(true);
    expect(planOutOfDate(open, CHANGED + 2 * MINUTE, CHANGED + 9 * MINUTE)).toBe(false);
    expect(planOutOfDate(open, CHANGED - MINUTE, CHANGED + 30 * MINUTE)).toBe(false);
    expect(planOutOfDate(finished, CHANGED + 30 * MINUTE, null)).toBe(false);
    expect(planOutOfDate(open, null, CHANGED + 30 * MINUTE)).toBe(false);
    expect(planOutOfDate({ ...open, updatedAt: Number.NaN }, CHANGED + 30 * MINUTE, null)).toBe(false);
  });

  it("measures the dog's latest work in this turn, not the plan's own update", () => {
    const at = (id: string, minutes: number, fields: Partial<Message>): Message => ({ id, role: "bot", kind: "activity", at: CHANGED + minutes * MINUTE, ...fields });
    expect(latestWorkAt([
      at("u", 1, { role: "user", kind: "text", text: "go" }),
      at("a", 5, { tool: { name: "Bash", ok: true } }),
      at("p", 20, { tool: { name: "mcp__agents__set_plan", ok: true } }),
    ])).toBe(CHANGED + 5 * MINUTE);
    expect(latestWorkAt([at("a", 5, { tool: { name: "Bash", ok: true } }), at("u", 9, { role: "user", kind: "text", text: "and?" })])).toBeNull();
  });

  it("shows when the plan is from and spins on no step the home has not confirmed lately", () => {
    const stale = renderToStaticMarkup(createElement(DogPlan, { plan: open, working: true, stale: true }));
    expect(stale).toContain("Plan from 8:30");
    expect(stale).toContain("may be out of date");
    expect(stale).not.toContain("animate-spin");
    const fresh = renderToStaticMarkup(createElement(DogPlan, { plan: open, working: true, stale: false }));
    expect(fresh).not.toContain("may be out of date");
    expect(fresh).toContain("animate-spin");
  });
});
