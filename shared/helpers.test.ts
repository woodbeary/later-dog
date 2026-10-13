import { describe, expect, it } from "vitest";

import { HELPER_LIMIT, applyHelperUpdate, helperRunning, withoutSettledHelpers, type Helper } from "./helpers.ts";

const helper = (id: string, extra: Partial<Helper> = {}): Helper => ({
  id, kind: "agent", label: `Helper ${id}`, state: "running", background: true, startedAt: 1, ...extra,
});

describe("applyHelperUpdate", () => {
  it("adds a new helper after the others and updates a known one in place", () => {
    const first = applyHelperUpdate([], helper("a"));
    const both = applyHelperUpdate(first, helper("b"));
    const updated = applyHelperUpdate(both, helper("a", { activity: "Reading the plan", toolUses: 3 }));
    expect(updated.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(updated[0]).toMatchObject({ activity: "Reading the plan", toolUses: 3 });
  });

  it("keeps a finished helper finished when a late progress update arrives", () => {
    const done = applyHelperUpdate([helper("a")], helper("a", { state: "done", endedAt: 9, summary: "Wrote the report" }));
    const late = applyHelperUpdate(done, helper("a", { activity: "Still reading" }));
    expect(late).toBe(done);
    expect(late[0]).toMatchObject({ state: "done", summary: "Wrote the report" });
  });

  it("lets a later final state replace an earlier one", () => {
    const stopped = applyHelperUpdate([helper("a")], helper("a", { state: "stopped" }));
    expect(applyHelperUpdate(stopped, helper("a", { state: "failed" }))[0]!.state).toBe("failed");
  });

  it("drops the oldest settled helpers past the limit and never a running one", () => {
    const settled = Array.from({ length: HELPER_LIMIT - 1 }, (_, index) => helper(`s${index}`, { state: "done" }));
    const running = [helper("r1"), ...settled];
    const next = applyHelperUpdate(applyHelperUpdate(running, helper("r2")), helper("r3"));
    expect(next).toHaveLength(HELPER_LIMIT);
    expect(next.map((entry) => entry.id)).toEqual(expect.arrayContaining(["r1", "r2", "r3"]));
    expect(next.some((entry) => entry.id === "s0")).toBe(false);
  });
});

describe("withoutSettledHelpers", () => {
  it("keeps only running helpers, and the same list when nothing settled", () => {
    const running = [helper("a"), helper("b")];
    expect(withoutSettledHelpers(running)).toBe(running);
    expect(withoutSettledHelpers([helper("a", { state: "done" }), helper("b")]).map((entry) => entry.id)).toEqual(["b"]);
    expect(helperRunning(helper("a", { state: "failed" }))).toBe(false);
  });
});
