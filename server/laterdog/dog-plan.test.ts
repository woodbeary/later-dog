import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { codexPlanSteps, EnginePlans, parsePlanItems, PlanCallers, planRecorded, PlanStore, todoWriteSteps } from "./dog-plan.ts";

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-plan-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("parsePlanItems", () => {
  it("accepts the whole list and tidies spacing", () => {
    expect(parsePlanItems([{ text: "  Fix   the login ", status: "in_progress" }, { text: "Ship it", status: "pending" }])).toEqual({ ok: true, items: [{ text: "Fix the login", status: "in_progress" }, { text: "Ship it", status: "pending" }] });
    expect(parsePlanItems([])).toEqual({ ok: true, items: [] });
  });

  it("refuses more than 20 items, long items, blank text and unknown statuses", () => {
    expect(parsePlanItems(Array.from({ length: 21 }, () => ({ text: "x", status: "pending" })))).toMatchObject({ ok: false, error: expect.stringContaining("at most 20 items") });
    expect(parsePlanItems([{ text: "x".repeat(201), status: "pending" }])).toMatchObject({ ok: false, error: expect.stringContaining("keep each item to 200") });
    expect(parsePlanItems([{ text: " ", status: "pending" }])).toMatchObject({ ok: false, error: "Item 1 needs text." });
    expect(parsePlanItems([{ text: "x", status: "completed" }])).toMatchObject({ ok: false, error: expect.stringContaining("pending, in_progress or done") });
    expect(parsePlanItems("x")).toMatchObject({ ok: false });
  });
});

describe("engine plans", () => {
  it("maps a task list and a Codex plan into the same items", () => {
    expect(todoWriteSteps({ todos: [{ content: "Read", status: "completed" }, { activeForm: "Fixing", status: "in_progress" }, { content: "Test", status: "pending" }] }))
      .toEqual([{ text: "Read", status: "done" }, { text: "Fixing", status: "in_progress" }, { text: "Test", status: "pending" }]);
    expect(codexPlanSteps([{ step: "Read", status: "completed" }, { step: "Fix", status: "inProgress" }, { step: "", status: "pending" }]))
      .toEqual([{ text: "Read", status: "done" }, { text: "Fix", status: "in_progress" }]);
    expect(todoWriteSteps(undefined)).toEqual([]);
  });

  it("hands engine plans to every listener", () => {
    const feed = new EnginePlans();
    const seen: unknown[] = [];
    const stop = feed.listen((threadId, items) => seen.push([threadId, items]));
    feed.report("t1", [{ text: "a", status: "pending" }]);
    stop();
    feed.report("t1", []);
    expect(seen).toEqual([["t1", [{ text: "a", status: "pending" }]]]);
  });
});

describe("PlanStore", () => {
  it("replaces a chat's plan, keeps it across a restart and keeps chats apart", () => {
    const path = join(scratch(), "dog-plans.json");
    let now = 1;
    const first = new PlanStore(path, () => now);
    first.set("t1", [{ text: "a", status: "pending" }], "dog");
    now = 2;
    first.set("t1", [{ text: "a", status: "done" }, { text: "b", status: "in_progress" }], "dog");
    first.set("t2", [{ text: "helper work", status: "pending" }], "helper");
    const again = new PlanStore(path);
    expect(again.get("t1")).toEqual({ items: [{ text: "a", status: "done" }, { text: "b", status: "in_progress" }], updatedAt: 2 });
    expect(again.get("t2")?.items).toEqual([{ text: "helper work", status: "pending" }]);
    expect(again.get("t3")).toBeUndefined();
    expect(again.forget("t2")).toBe(true);
    expect(new PlanStore(path).get("t2")).toBeUndefined();
  });

  it("keeps only the most recently set chats and survives a broken file", () => {
    const path = join(scratch(), "dog-plans.json");
    const plans = new PlanStore(path, Date.now, 2);
    for (const id of ["a", "b", "c"]) plans.set(id, [{ text: id, status: "pending" }]);
    expect(JSON.parse(readFileSync(path, "utf8")).map((row: { threadId: string }) => row.threadId)).toEqual(["b", "c"]);
    rmSync(path);
    expect(new PlanStore(path).get("b")).toBeUndefined();
  });
});

describe("PlanCallers", () => {
  it("answers at once for a known call, waits for one announced late, and treats an unknown call as the dog's", async () => {
    const callers = new PlanCallers();
    callers.note("dog-call", "dog");
    expect(await callers.of("dog-call", 1_000)).toBe("dog");
    const late = callers.of("helper-call", 1_000);
    callers.note("helper-call", "helper");
    expect(await late).toBe("helper");
    expect(await callers.of("never-seen", 10)).toBe("dog");
    expect(await callers.of(undefined, 1_000)).toBe("dog");
  });
});

it("confirms in one short line", () => {
  expect(planRecorded([{ text: "Read", status: "done" }, { text: "Fix", status: "in_progress" }, { text: "Ship", status: "pending" }]))
    .toBe("Plan recorded: 1 of 3 done, now “Fix”, 1 not started. The person sees it in the app.");
  expect(planRecorded([])).toBe("Plan cleared.");
});
