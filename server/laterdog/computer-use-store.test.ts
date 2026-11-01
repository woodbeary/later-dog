import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { FIXTURE_VIEWER, memoryStore } from "./computer-use-fakes.ts";
import { ComputerUseStore } from "./computer-use-store.ts";
import type { DoneRule } from "./computer-use-done.ts";

const PERSON_ONLY: DoneRule = { pageCheck: null };
const WITH_PAGE: DoneRule = { pageCheck: { url: "https://clinic.example/requests/42", contains: "Request received" } };
const begin = (done: DoneRule = PERSON_ONLY) => {
  const store = memoryStore();
  return { store, run: store.start({ task: "Send the interpreter request", computerId: "cmp_fixture12345", model: "claude-opus-5-5", done }) };
};

describe("the definition of done is fixed before any data", () => {
  it("refuses to start a run that does not say what done means", () => {
    const store = memoryStore();
    const start = (done: unknown) => store.start({ task: "x", computerId: "cmp_fixture12345", model: "claude-opus-5-5", done: done as DoneRule });
    expect(() => start(undefined)).toThrow();
    expect(() => start({})).toThrow();
    expect(() => start({ pageCheck: { url: "http://clinic.example/", contains: "ok" } })).toThrow(/https address/);
    expect(() => start({ pageCheck: { url: "https://user:pw@clinic.example/", contains: "ok" } })).toThrow(/no credentials/);
    expect(() => start({ pageCheck: { url: "https://clinic.example/", contains: "  " } })).toThrow();
    expect(store.runs()).toEqual([]);
  });

  it("keeps the rule the run started with", () => {
    const { store, run } = begin(WITH_PAGE);
    expect(run).toMatchObject({ state: "running", model: "claude-opus-5-5", done: WITH_PAGE, doneSource: null, failure: null });
    expect(store.run(run.id).done).toEqual(WITH_PAGE);
  });

  it("lets a page check finish a run only when the run has one", () => {
    const personOnly = begin();
    expect(() => personOnly.store.finish(personOnly.run.id, { done: "page_check" })).toThrow("only the person can say it is done");
    const withPage = begin(WITH_PAGE);
    expect(withPage.store.finish(withPage.run.id, { done: "page_check", detail: "HTTP 200" })).toMatchObject({ state: "done", doneSource: "page_check" });
  });

  it("ends a run once", () => {
    const { store, run } = begin();
    expect(store.finish(run.id, { done: "person" })).toMatchObject({ state: "done", doneSource: "person" });
    expect(() => store.finish(run.id, { failed: "stopped" })).toThrow("already ended (done)");
    expect(() => store.awaitPerson(run.id, "Claude says it is finished.")).toThrow();
  });
});

describe("take-overs keep their cause", () => {
  it("logs who asked, why, and when the screen came back", () => {
    const { store, run } = begin();
    store.handOver(run.id, "captcha", "model", "Solve the CAPTCHA on the request form");
    expect(store.run(run.id).state).toBe("handed_over");
    expect(() => store.handOver(run.id, "person", "person", "")).toThrow("already has");
    store.handBack(run.id);
    store.handOver(run.id, "person", "person", "");
    expect(store.handoffs(run.id)).toEqual([
      { number: 1, at: expect.any(String), cause: "captcha", askedBy: "model", note: "Solve the CAPTCHA on the request form", returnedAt: expect.any(String), viewerUrl: null, viewerExpiresAt: null, probability: null },
      { number: 2, at: expect.any(String), cause: "person", askedBy: "person", note: "", returnedAt: null, viewerUrl: null, viewerExpiresAt: null, probability: null },
    ]);
    store.finish(run.id, { done: "person" });
    expect(store.handoffs(run.id)[1]!.returnedAt).not.toBeNull();
  });

  it("keeps the viewer link on the open take-over only, and drops it when the screen comes back", () => {
    const { store, run } = begin();
    store.handOver(run.id, "sign-in", "model", "Sign in to the clinic portal");
    expect(store.attachViewer(run.id, 1, FIXTURE_VIEWER)).toMatchObject({ number: 1, viewerUrl: FIXTURE_VIEWER.url, viewerExpiresAt: FIXTURE_VIEWER.expiresAt });
    expect(store.openHandoff(run.id)).toMatchObject({ viewerUrl: FIXTURE_VIEWER.url });
    store.handBack(run.id);
    expect(store.openHandoff(run.id)).toBeNull();
    expect(store.handoffs(run.id)[0]).toMatchObject({ viewerUrl: null, viewerExpiresAt: FIXTURE_VIEWER.expiresAt });
    expect(store.attachViewer(run.id, 1, FIXTURE_VIEWER)).toMatchObject({ viewerUrl: null });
  });

  it("adds the new columns to a log made before they existed", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE computer_use_handoffs (run_id TEXT NOT NULL, number INTEGER NOT NULL, at TEXT NOT NULL,
      cause TEXT NOT NULL, asked_by TEXT NOT NULL, note TEXT NOT NULL, returned_at TEXT, PRIMARY KEY (run_id, number))`);
    db.prepare("INSERT INTO computer_use_handoffs VALUES (?,?,?,?,?,?,?)").run("old-run", 1, "2026-10-31T20:00:00.000Z", "captcha", "model", "Solve it", null);
    new ComputerUseStore(db);
    new ComputerUseStore(db);
    expect(new ComputerUseStore(db).handoffs("old-run")).toEqual([expect.objectContaining({ number: 1, cause: "captcha", viewerUrl: null, viewerExpiresAt: null })]);
  });

  it("refuses a cause it does not know and a screen that is not in play", () => {
    const { store, run } = begin();
    expect(() => store.handOver(run.id, "boredom" as never, "person", "")).toThrow(/sign-in, captcha, payment, other, person/);
    expect(() => store.handBack(run.id)).toThrow("does not have");
    store.awaitPerson(run.id, "Claude says it is finished.");
    expect(() => store.handOver(run.id, "person", "person", "")).toThrow("awaiting_done");
  });
});

describe("steps and restarts", () => {
  it("keeps each step's actions, screenshot hash, latency and tokens", () => {
    const { store, run } = begin();
    store.step(run.id, { step: 1, actions: [{ name: "left_click", coordinate: [1, 2] }], screenshotSha256: "a".repeat(64), modelMs: 812, actionMs: 40,
      inputTokens: 1400, outputTokens: 90, cacheReadTokens: 1200, cacheWriteTokens: 0 });
    expect(store.steps(run.id)).toEqual([{ step: 1, at: expect.any(String), actions: [{ name: "left_click", coordinate: [1, 2] }], screenshotSha256: "a".repeat(64),
      modelMs: 812, actionMs: 40, inputTokens: 1400, outputTokens: 90, cacheReadTokens: 1200, cacheWriteTokens: 0, screenState: null, screenProbability: null, outcome: null }]);
  });

  it("keeps the screen check's verdict on the frame Claude chose from, and whether the run had screen checks", () => {
    const store = memoryStore();
    const run = store.start({ task: "x", computerId: "cmp_fixture12345", model: "claude-opus-5-5", done: PERSON_ONLY, screenChecks: true });
    expect(run.screenChecks).toBe(true);
    store.step(run.id, { step: 1, actions: [], screenshotSha256: "b".repeat(64), modelMs: 1, actionMs: 0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0,
      cacheWriteTokens: 0, screenState: "two_factor", screenProbability: 0.88 });
    expect(store.steps(run.id)[0]).toMatchObject({ screenState: "two_factor", screenProbability: 0.88 });
    store.handOver(run.id, "sign-in", "screen_check", "The screen check saw two factor (0.88)", 0.88);
    expect(store.openHandoff(run.id)).toMatchObject({ askedBy: "screen_check", probability: 0.88 });
    expect(begin().run.screenChecks).toBe(false);
  });

  it("keeps a run with an unknown submit open for the person, through a restart", () => {
    const store = memoryStore();
    const run = store.start({ task: "x", computerId: "cmp_fixture12345", model: "claude-opus-5-5", done: PERSON_ONLY });
    store.step(run.id, { step: 1, actions: [{ name: "left_click", coordinate: [900, 700] }], screenshotSha256: "c".repeat(64), modelMs: 1, actionMs: 1,
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outcome: "submission_unknown" });
    expect(store.awaitPerson(run.id, "Whether a submit went through is unknown.", true).state).toBe("submission_unknown");
    expect(store.interrupted()).toBe(0);
    expect(() => store.handOver(run.id, "person", "person", "")).toThrow("submission_unknown");
    expect(store.steps(run.id)[0]!.outcome).toBe("submission_unknown");
    expect(store.finish(run.id, { failed: "not_done" })).toMatchObject({ state: "failed", failure: "not_done" });
  });

  it("fails runs a restart cut off, and leaves runs that wait for the person alone", () => {
    const store = memoryStore();
    const start = () => store.start({ task: "x", computerId: "cmp_fixture12345", model: "claude-opus-5-5", done: PERSON_ONLY });
    const going = start(); const handed = start(); const waiting = start();
    store.handOver(handed.id, "sign-in", "model", "Sign in");
    store.awaitPerson(waiting.id, "Claude says it is finished.");
    expect(store.interrupted()).toBe(2);
    expect(store.run(going.id)).toMatchObject({ state: "failed", failure: "interrupted" });
    expect(store.run(handed.id)).toMatchObject({ state: "failed", failure: "interrupted" });
    expect(store.run(waiting.id).state).toBe("awaiting_done");
    expect(store.finish(waiting.id, { done: "person" }).doneSource).toBe("person");
  });
});
