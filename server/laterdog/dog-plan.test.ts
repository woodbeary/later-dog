import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { codexPlanSteps, corruptPlansPath, cutToFit, EnginePlans, forgetDeletedChats, parsePlanItems, PLAN_CALLERS_KEPT, PlanCallers, planRecorded, PlanStore, todoWriteSteps, visibleText } from "./dog-plan.ts";

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
    expect(parsePlanItems([{ text: " ", status: "pending" }])).toMatchObject({ ok: false, error: "Item 1 needs text that can be seen." });
    expect(parsePlanItems([{ text: "x", status: "completed" }])).toMatchObject({ ok: false, error: expect.stringContaining("pending, in_progress or done") });
    expect(parsePlanItems("x")).toMatchObject({ ok: false });
  });
});

describe("text that can be seen", () => {
  it("drops control and format characters before the checks, and refuses an item with nothing visible", () => {
    expect(visibleText("Fix\u0000 the\u202E login\u200B")).toBe("Fix the login");
    expect(visibleText("line one\nline two\t")).toBe("line one line two");
    expect(visibleText("\u200B\u200C\u2060\u0007")).toBe("");
    expect(visibleText("\u200D")).toBe("");
    expect(visibleText("Ship 👩‍💻")).toBe("Ship 👩‍💻");
    expect(parsePlanItems([{ text: "\u200B\u200B", status: "pending" }])).toMatchObject({ ok: false });
    expect(parsePlanItems([{ text: "\u200B".repeat(300) + "Fix", status: "pending" }])).toEqual({ ok: true, items: [{ text: "Fix", status: "pending" }] });
    expect(parsePlanItems([{ text: "a", status: "in_progress" }, { text: "b", status: "in_progress" }])).toMatchObject({ ok: true });
  });
});

describe("engine plans", () => {
  it("maps a task list and a Codex plan into the same items", () => {
    expect(todoWriteSteps({ todos: [{ content: "Read", status: "completed" }, { activeForm: "Fixing", status: "in_progress" }, { content: "Test", status: "pending" }] }))
      .toEqual([{ text: "Read", status: "done" }, { text: "Fixing", status: "in_progress" }, { text: "Test", status: "pending" }]);
    expect(codexPlanSteps([{ step: "Read", status: "completed" }, { step: "Fix", status: "inProgress" }, { step: "", status: "pending" }]))
      .toEqual([{ text: "Read", status: "done" }, { text: "Fix", status: "in_progress" }]);
    expect(todoWriteSteps({ todos: [{ content: "\u200B", status: "pending" }, { content: "Real", status: "pending" }] })).toEqual([{ text: "Real", status: "pending" }]);
  });

  it("ignores a list it cannot read, and clears only on an explicitly empty list", () => {
    expect(todoWriteSteps(undefined)).toBeNull();
    expect(todoWriteSteps({ todos: "x" })).toBeNull();
    expect(todoWriteSteps({ todos: [{ status: "pending" }, 7, { content: "\u200B" }] })).toBeNull();
    expect(codexPlanSteps({ step: "x" })).toBeNull();
    expect(codexPlanSteps([{ explanation: "x" }])).toBeNull();
    expect(todoWriteSteps({ todos: [] })).toEqual([]);
    expect(codexPlanSteps([])).toEqual([]);
  });

  it("cuts a long engine item between whole characters", () => {
    const coder = "\u{1F469}\u200D\u{1F4BB}";
    expect(cutToFit(`${"a".repeat(198)}${coder}`)).toBe("a".repeat(198));
    expect(cutToFit(`${"a".repeat(195)}${coder}`)).toBe(`${"a".repeat(195)}${coder}`);
    const paws = cutToFit("\u{1F43E}".repeat(150));
    expect(paws).toBe("\u{1F43E}".repeat(100));
    const [step] = todoWriteSteps({ todos: [{ content: `${"word ".repeat(38)}ends ${coder}${coder}`, status: "pending" }] })!;
    expect(step!.text.length).toBeLessThanOrEqual(200);
    expect(step!.text.endsWith(coder)).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(step!.text)).toBe(false);
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

  it("keeps only the most recently set chats", () => {
    const path = join(scratch(), "dog-plans.json");
    const plans = new PlanStore(path, Date.now, 2);
    for (const id of ["a", "b", "c"]) plans.set(id, [{ text: id, status: "pending" }]);
    expect(JSON.parse(readFileSync(path, "utf8")).map((row: { threadId: string }) => row.threadId)).toEqual(["b", "c"]);
  });

  it("moves a corrupt file aside, replacing an earlier one, instead of writing over it", () => {
    const path = join(scratch(), "dog-plans.json");
    const aside = corruptPlansPath(path);
    expect(aside).toBe(path.replace(/dog-plans\.json$/, "dog-plans.corrupt.json"));
    writeFileSync(aside, "older");
    writeFileSync(path, "[{\"threadId\": \"t1\", trunc");
    const plans = new PlanStore(path);
    expect(plans.get("t1")).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(aside, "utf8")).toBe("[{\"threadId\": \"t1\", trunc");
    plans.set("t2", [{ text: "new", status: "pending" }]);
    expect(readFileSync(aside, "utf8")).toBe("[{\"threadId\": \"t1\", trunc");
    writeFileSync(path, "{}");
    new PlanStore(path);
    expect(readFileSync(aside, "utf8")).toBe("{}");
  });

  it("forgets the plan of a deleted chat, and only that one", () => {
    const plans = new PlanStore(join(scratch(), "dog-plans.json"));
    plans.set("kept", [{ text: "a", status: "pending" }]);
    plans.set("gone", [{ text: "b", status: "pending" }]);
    let listener: ((change: { type: string; threadId?: string }) => void) | undefined;
    const stop = forgetDeletedChats({ onChange: (next) => { listener = next; return () => { listener = undefined; }; } }, plans);
    listener!({ type: "thread", threadId: "gone" });
    expect(plans.get("gone")).toBeDefined();
    listener!({ type: "thread.deleted", threadId: "gone" });
    expect(plans.get("gone")).toBeUndefined();
    expect(plans.get("kept")).toBeDefined();
    stop();
    expect(listener).toBeUndefined();
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

  it("remembers enough calls that a busy home does not forget a helper's", async () => {
    const callers = new PlanCallers();
    callers.note("helper-call", "helper");
    for (let index = 0; index < PLAN_CALLERS_KEPT - 1; index += 1) callers.note(`dog-${index}`, "dog");
    expect(await callers.of("helper-call", 10)).toBe("helper");
    callers.note("one-more", "dog");
    expect(await callers.of("helper-call", 10)).toBe("dog");
  });
});

it("confirms in one short line", () => {
  expect(planRecorded([{ text: "Read", status: "done" }, { text: "Fix", status: "in_progress" }, { text: "Ship", status: "pending" }]))
    .toBe("Plan recorded: 1 of 3 done, now “Fix”, 1 not started. The person sees it in the app.");
  expect(planRecorded([])).toBe("Plan cleared. The person sees it in the app.");
  expect(planRecorded([{ text: "Read", status: "pending" }], false)).toBe("Plan recorded: 0 of 1 done, 1 not started.");
  expect(planRecorded([], false)).toBe("Plan cleared.");
});
