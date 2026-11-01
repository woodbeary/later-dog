import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { DoneRule } from "./computer-use-done.ts";
import { ComputerUseStore, type StepRecord } from "./computer-use-store.ts";

const SQL = [...readFileSync(new URL("../../docs/metrics.md", import.meta.url), "utf8").matchAll(/```sql\n([\s\S]*?)```/g)].map((match) => match[1]!);
const PERSON_ONLY: DoneRule = { pageCheck: null };
const WITH_PAGE: DoneRule = { pageCheck: { url: "https://clinic.example/requests/42", contains: "Request received" } };

function fixtureRuns() {
  const db = new DatabaseSync(":memory:");
  let clock = new Date("2026-01-05T10:00:00.000Z");
  const store = new ComputerUseStore(db, () => clock);
  const start = (done: DoneRule = PERSON_ONLY) => store.start({ task: "fixture", computerId: "cmp_fixture12345", model: "claude-opus-5-5", done }).id;
  const step = (runId: string, n: number, modelMs: number, actionMs: number): void => store.step(runId, {
    step: n, actions: [{ name: "screenshot" }], screenshotSha256: "0".repeat(64), modelMs, actionMs,
    inputTokens: 1000 * n, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 0,
  } satisfies StepRecord);

  const guarded: StepRecord = { step: 1, actions: [{ name: "left_click", coordinate: [900, 700] }], screenshotSha256: "1".repeat(64), modelMs: 900, actionMs: 100,
    inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, outcome: "submission_unknown" };

  const byPerson = start();
  step(byPerson, 1, 700, 100);
  step(byPerson, 2, 900, 100);
  store.handOver(byPerson, "captcha", "model", "Solve the CAPTCHA");
  store.handBack(byPerson);
  store.finish(byPerson, { done: "person" });

  const byPage = start(WITH_PAGE);
  step(byPage, 1, 1800, 200);
  store.screenAfter(byPage, 1, true);
  store.screenAfter(byPerson, 1, false);
  store.classify(byPerson, 2, "page_not_settled");
  store.classify(byPage, 1, "page_not_settled");
  store.finish(byPage, { done: "page_check" });

  const notDone = start();
  store.handOver(notDone, "person", "person", "");
  store.finish(notDone, { failed: "not_done" });

  const abandoned = start();
  store.awaitPerson(abandoned, "Claude says it is finished.");

  const unknown = start();
  store.handOver(unknown, "confirm", "guard", "Claude wants to left_click at (900, 700)", 0.94);
  store.handBack(unknown);
  store.step(unknown, { ...guarded, step: 1 });
  store.awaitPerson(unknown, "Whether a submit went through is unknown.", true);

  const unknownThenDone = start(WITH_PAGE);
  store.step(unknownThenDone, { ...guarded, step: 1 });
  store.finish(unknownThenDone, { done: "page_check" });

  clock = new Date();
  const waiting = start();
  store.awaitPerson(waiting, "Claude says it is finished.");
  start();
  return db;
}

describe("the SQL in docs/metrics.md", () => {
  const db = fixtureRuns();
  const run = (index: number) => db.prepare(SQL[index]!).all().map((row) => ({ ...row }));

  it("has the ten queries this test checks", () => {
    expect(SQL).toHaveLength(10);
  });

  it("counts success over settled runs, with an abandoned run and an unsettled unknown submit as failed", () => {
    expect(run(0)).toEqual([{ week: "2026-01", settled: 6, done: 3, success_pct: 50 }]);
  });

  it("says how each run ended", () => {
    expect(run(1)).toEqual(expect.arrayContaining([
      { state: "done", how: "person", runs: 1 },
      { state: "done", how: "page_check", runs: 2 },
      { state: "failed", how: "not_done", runs: 1 },
      { state: "awaiting_done", how: "abandoned", runs: 1 },
      { state: "awaiting_done", how: "waiting", runs: 1 },
      { state: "submission_unknown", how: "submission_unknown", runs: 1 },
    ]));
    expect(run(1)).toHaveLength(6);
  });

  it("counts take-overs, their causes, and the runs that were done after one", () => {
    expect(run(2)).toEqual([{ settled: 6, with_takeover: 3, with_takeover_done: 1 }]);
    expect(run(3)).toEqual(expect.arrayContaining([{ cause: "captcha", asked_by: "model", takeovers: 1 }, { cause: "person", asked_by: "person", takeovers: 1 },
      { cause: "confirm", asked_by: "guard", takeovers: 1 }]));
  });

  it("counts unknown submits and how their runs were settled", () => {
    expect(run(4)).toEqual([{ unknown_submits: 2, settled_done: 1, settled_failed: 0, still_unknown: 1 }]);
  });

  it("counts the review's failure classes and the actions that changed nothing on screen", () => {
    expect(run(5)).toEqual([{ failure_class: "page_not_settled", steps: 2 }]);
    expect(run(6)).toEqual([{ compared: 2, unchanged: 1, unchanged_pct: 50 }]);
  });

  it("finds the median and 95th percentile step time", () => {
    expect(run(7)).toEqual([{ p50_ms: 1000, p95_ms: 2000 }]);
  });

  it("adds up steps and tokens per run, and shows one pinned model", () => {
    const perRun = run(8);
    expect(perRun).toHaveLength(8);
    expect(perRun).toEqual(expect.arrayContaining([expect.objectContaining({ state: "done", steps: 2, input_tokens: 3000, output_tokens: 100, cache_read_tokens: 1800 })]));
    expect(run(9)).toEqual([{ model: "claude-opus-5-5", runs: 8 }]);
  });
});
