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

  const byPerson = start();
  step(byPerson, 1, 700, 100);
  step(byPerson, 2, 900, 100);
  store.handOver(byPerson, "captcha", "model", "Solve the CAPTCHA");
  store.handBack(byPerson);
  store.finish(byPerson, { done: "person" });

  const byPage = start(WITH_PAGE);
  step(byPage, 1, 1800, 200);
  store.finish(byPage, { done: "page_check" });

  const notDone = start();
  store.handOver(notDone, "person", "person", "");
  store.finish(notDone, { failed: "not_done" });

  const abandoned = start();
  store.awaitPerson(abandoned, "Claude says it is finished.");

  clock = new Date();
  const waiting = start();
  store.awaitPerson(waiting, "Claude says it is finished.");
  start();
  return db;
}

describe("the SQL in docs/metrics.md", () => {
  const db = fixtureRuns();
  const run = (index: number) => db.prepare(SQL[index]!).all().map((row) => ({ ...row }));

  it("has the seven queries this test checks", () => {
    expect(SQL).toHaveLength(7);
  });

  it("counts success over settled runs, with an abandoned run as failed", () => {
    expect(run(0)).toEqual([{ week: "2026-01", settled: 4, done: 2, success_pct: 50 }]);
  });

  it("says how each run ended", () => {
    expect(run(1)).toEqual(expect.arrayContaining([
      { state: "done", how: "person", runs: 1 },
      { state: "done", how: "page_check", runs: 1 },
      { state: "failed", how: "not_done", runs: 1 },
      { state: "awaiting_done", how: "abandoned", runs: 1 },
      { state: "awaiting_done", how: "waiting", runs: 1 },
    ]));
    expect(run(1)).toHaveLength(5);
  });

  it("counts take-overs, their causes, and the runs that were done after one", () => {
    expect(run(2)).toEqual([{ settled: 4, with_takeover: 2, with_takeover_done: 1 }]);
    expect(run(3)).toEqual(expect.arrayContaining([{ cause: "captcha", asked_by: "model", takeovers: 1 }, { cause: "person", asked_by: "person", takeovers: 1 }]));
  });

  it("finds the median and 95th percentile step time", () => {
    expect(run(4)).toEqual([{ p50_ms: 1000, p95_ms: 2000 }]);
  });

  it("adds up steps and tokens per run, and shows one pinned model", () => {
    const perRun = run(5);
    expect(perRun).toHaveLength(6);
    expect(perRun).toEqual(expect.arrayContaining([expect.objectContaining({ state: "done", steps: 2, input_tokens: 3000, output_tokens: 100, cache_read_tokens: 1800 })]));
    expect(run(6)).toEqual([{ model: "claude-opus-5-5", runs: 6 }]);
  });
});
