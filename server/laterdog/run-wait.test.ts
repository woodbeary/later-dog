import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PERSON_WROTE_TEXT, WROTE_BEFORE_START_TEXT, handleComputerRun, stoppedWaitText } from "./computer-run-route.ts";
import { ComputerRuns, WAIT_IN_ONE_CALL_MS, type RunBox, type RunOutcome } from "./computer-runs.ts";
import { BAD_WAIT_TEXT, STILL_RUNNING_TAIL_CHARS, stillRunningTail, waitCapMs, waitWindowMs } from "./run-wait.ts";
import { isPoll, pollAnswer } from "../testing/poll-answer.ts";

const MINUTE = 60_000;

function job(endsAfterMs: number, onWrite: () => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "run-wait-"));
  mkdirSync(join(root, "site"), { recursive: true });
  writeFileSync(join(root, "site/check.ts"), "export const check = 1;\n");
  const clock = { at: 1_000_000 };
  const endsAt = clock.at + endsAfterMs;
  const log = "x".repeat(12_000);
  const execs: string[] = [];
  const box: RunBox = {
    async exec(command) {
      execs.push(command);
      if (isPoll(command)) return { exitCode: 0, stdout: pollAnswer(command, clock.at >= endsAt ? 0 : null, log), stderr: "" };
      if (command.includes("nohup")) return { exitCode: 0, stdout: "started\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async write() { onWrite(); },
    async read() { return Buffer.alloc(0); },
  };
  const runs = new ComputerRuns(join(root, "state"), { now: () => clock.at, sleep: async (ms) => { clock.at += ms; } });
  const computer = async () => ({ box });
  async function waitOut(extra: Record<string, unknown>, maxWaitMs?: number) {
    const texts: string[] = [];
    let body: Record<string, unknown> = { command: "pnpm gate", folder: join(root, "site"), ...extra };
    for (let call = 0; call < 50; call += 1) {
      const answer = await handleComputerRun({ botId: "dog", body, workingFolder: null, allowedRoots: [], home: root, ...(maxWaitMs ? { maxWaitMs } : {}) }, { runs, computer, now: () => clock.at });
      texts.push(answer.text ?? "");
      const still = /^Still running.*run_id ([0-9a-f]{8})/.exec(answer.text ?? "");
      if (!still) break;
      body = { run_id: still[1], ...extra };
    }
    return texts;
  }
  const once = (extra: Record<string, unknown>, request: { active?: () => boolean; interrupted?: () => boolean } = {}) =>
    handleComputerRun({ botId: "dog", body: { command: "pnpm gate", folder: join(root, "site"), ...extra }, workingFolder: null, allowedRoots: [], home: root, maxWaitMs: 60 * MINUTE, ...request }, { runs, computer, now: () => clock.at });
  return { waitOut, once, clock, execs, runs, computer, root };
}

describe("waiting for a computer job with one call", () => {
  it("waits for a job that ends after 50 minutes in one call, where the 4-minute window took 13", async () => {
    const polled = await job(50 * MINUTE).waitOut({});
    expect(polled).toHaveLength(13);
    const waited = await job(50 * MINUTE).waitOut({ wait_minutes: 60 }, waitCapMs("claudeAgent", 10));
    expect(waited).toHaveLength(1);
    expect(waited[0]).toMatch(/^Finished on your cloud computer with exit code 0/);
  });

  it("keeps a still-running answer short and gives the whole tail once the job ends", async () => {
    const texts = await job(10 * MINUTE).waitOut({});
    expect(texts[0]).toMatch(/^Still running/);
    expect(texts[0].length).toBeLessThan(STILL_RUNNING_TAIL_CHARS + 600);
    expect(texts.at(-1)!.length).toBeGreaterThan(12_000);
  });

  it("never waits longer than the engine lets a tool call last, and keeps the old window when no wait is asked", () => {
    expect(waitCapMs("claudeAgent", 10)).toBe(60 * MINUTE);
    expect(waitCapMs("codex", 10)).toBe(9 * MINUTE);
    expect(waitCapMs("codex", 3)).toBe(WAIT_IN_ONE_CALL_MS);
    expect(waitCapMs("piAgent", 30)).toBe(9 * MINUTE);
    expect(waitCapMs("piAgent", 5)).toBe(WAIT_IN_ONE_CALL_MS);
    expect(waitCapMs(undefined, 120)).toBe(60 * MINUTE);
    expect(waitWindowMs(undefined, 60 * MINUTE)).toBe(WAIT_IN_ONE_CALL_MS);
    expect(waitWindowMs(30, 60 * MINUTE)).toBe(30 * MINUTE);
    expect(waitWindowMs(60, 9 * MINUTE)).toBe(9 * MINUTE);
    expect(waitWindowMs(60)).toBe(WAIT_IN_ONE_CALL_MS);
    expect(waitWindowMs(null, 60 * MINUTE)).toBe(WAIT_IN_ONE_CALL_MS);
    for (const bad of [0, -5, 0.5, 1.5, 61, "10", Number.NaN, true]) expect(waitWindowMs(bad, 60 * MINUTE)).toBeNull();
  });

  it("ends a long wait within one poll of the person pressing Stop, and brings nothing back after it", async () => {
    const j = job(50 * MINUTE);
    const start = j.clock.at;
    const answer = await j.once({ wait_minutes: 60 }, { active: () => j.clock.at - start < 5 * MINUTE });
    expect(answer.status).toBe(409);
    expect(answer.error).toMatch(/^The wait ended because this turn was stopped\. The job is still running on your cloud computer \(run_id [0-9a-f]{8}\)\./);
    expect(answer.error).not.toMatch(/nothing was run/);
    expect(j.clock.at - start).toBeLessThanOrEqual(5 * MINUTE + 10_000);
    expect(j.execs.some((command) => command.includes("python3 -c"))).toBe(false);
  });

  it("says the files are in the folder when Stop lands while they are being brought back", async () => {
    const j = job(MINUTE);
    const answer = await j.once({ wait_minutes: 30 }, { active: () => !j.execs.some((command) => command.includes("python3 -c")) });
    expect(answer.status).toBe(409);
    expect(answer.error).toMatch(/^The wait ended because this turn was stopped\. The job finished with exit code 0 \(run_id [0-9a-f]{8}\) and its files were brought back to your folder/);
    expect(answer.error).not.toMatch(/not brought back/);
    const done: RunOutcome = { id: "abcd1234", state: "finished", exitCode: 0, output: "", broughtBack: ["out.txt"], skipped: [], sentFiles: 0, sentBytes: 0 };
    expect(stoppedWaitText(done)).toContain("its files were brought back to your folder (1 changed file)");
  });

  it("stops waiting early when the person writes, so the dog can answer and wait again with the run_id", async () => {
    const j = job(20 * MINUTE);
    const start = j.clock.at;
    const first = await j.once({ wait_minutes: 60 }, { active: () => true, interrupted: () => j.clock.at - start >= 3 * MINUTE });
    expect(first.status).toBe(200);
    expect(first.text!.startsWith(PERSON_WROTE_TEXT)).toBe(true);
    expect(first.text).toMatch(/Still running on your cloud computer \(run_id ([0-9a-f]{8})\)/);
    expect(j.clock.at - start).toBeLessThanOrEqual(3 * MINUTE + 10_000);
    const runId = /run_id ([0-9a-f]{8})/.exec(first.text!)![1];
    const second = await handleComputerRun({ botId: "dog", body: { run_id: runId, wait_minutes: 60 }, workingFolder: null, allowedRoots: [], maxWaitMs: 60 * MINUTE, active: () => true, interrupted: () => false }, { runs: j.runs, computer: j.computer, now: () => j.clock.at });
    expect(second.text).toMatch(/^Finished on your cloud computer with exit code 0/);
  });

  it("refuses a wait that is not a whole number of minutes from 1 to 60, in a plain sentence, before anything runs", async () => {
    const j = job(MINUTE);
    for (const bad of [0, -5, 0.5, "10"]) {
      const answer = await j.once({ wait_minutes: bad });
      expect(answer).toEqual({ status: 400, error: BAD_WAIT_TEXT });
    }
    expect(j.execs).toEqual([]);
  });

  it("keeps the first line that looks like an error when it shortens a running job's output, and says it was shortened", () => {
    const log = ["ERROR: step one failed", ...Array.from({ length: 200 }, (_, i) => `line ${i} is fine and long enough to fill the log`)].join("\n");
    const shown = stillRunningTail(log);
    expect(shown).toMatch(/^\(Output shortened to its last 2,000 characters while the job runs/);
    expect(shown).toContain("First line that looks like an error: ERROR: step one failed");
    expect(shown.endsWith(log.slice(-STILL_RUNNING_TAIL_CHARS))).toBe(true);
    expect(stillRunningTail("short and fine")).toBe("short and fine");
  });

  it("gives a 30-minute wait the whole 30 minutes through the route, never the old 4", async () => {
    const root = mkdtempSync(join(tmpdir(), "run-wait-window-"));
    mkdirSync(join(root, "site"), { recursive: true });
    const windows: number[] = [];
    const runs = { record: () => null, run: async (_box: unknown, input: { left: () => number }) => { windows.push(input.left()); return { id: "abcd1234", state: "finished", exitCode: 0, output: "ok", broughtBack: [], skipped: [], sentFiles: 0, sentBytes: 0 }; } } as unknown as ComputerRuns;
    const computer = async () => ({ box: {} as RunBox });
    const budgets: number[] = [];
    const answer = await handleComputerRun({ botId: "dog", body: { command: "pnpm gate", folder: join(root, "site"), wait_minutes: 30 }, workingFolder: null, allowedRoots: [], home: root, maxWaitMs: waitCapMs("claudeAgent", 10) },
      { runs, computer: async (_bot, options) => { budgets.push(options?.budgetMs ?? 0); return computer(); }, now: () => 5_000_000 });
    expect(answer.status).toBe(200);
    expect(windows).toEqual([30 * MINUTE]);
    expect(budgets).toEqual([30 * MINUTE]);
  });

  it("says the person wrote and the command was not started when a message comes while the folder is sent", async () => {
    let wrote = false;
    const j = job(MINUTE, () => { wrote = true; });
    const answer = await j.once({ wait_minutes: 30 }, { active: () => true, interrupted: () => wrote });
    expect(answer).toEqual({ status: 200, text: WROTE_BEFORE_START_TEXT });
    expect(answer.text).not.toMatch(/time ran out/);
    expect(j.execs.some((command) => command.includes("nohup"))).toBe(false);
  });

  it("does not take a line that reports zero errors or failures for an error", () => {
    const fine = ["Found 0 warnings and 0 errors.", "Tests  168 passed, 0 failed", "errors: 0", "No failures found."];
    const filler = Array.from({ length: 200 }, (_, i) => `line ${i} is fine and long enough to fill the log`);
    expect(stillRunningTail([...fine, ...filler].join("\n"))).not.toMatch(/First line that looks like an error/);
    expect(stillRunningTail([...fine, "Tests 3 failed | 0 errors", ...filler].join("\n"))).toContain("First line that looks like an error: Tests 3 failed | 0 errors");
  });

  it("still picks a real error that starts with a zero, and skips every line that only reports none", () => {
    const filler = Array.from({ length: 200 }, (_, i) => `line ${i} is fine and long enough to fill the log`);
    const first = (line: string) => /First line that looks like an error: (.*)/.exec(stillRunningTail([line, ...filler].join("\n")))?.[1] ?? null;
    const none = ["Found 0 warnings and 0 errors.", "Tests  168 passed, 0 failed", "errors: 0", "No failures found.", "0 errors, 0 warnings", "Errors: 0, Failures: 0", "failures=0", "zero errors", "no errors"];
    for (const line of none) expect(first(line), line).toBeNull();
    const real = ["Error: 0 is not a valid port", "error: 0 tests found", "failed: 0 files could be read", "0 passed, 3 failed", "error: exit code 0 expected", "Tests 3 failed | 0 errors", "FAILED (errors=0, failures=3)", "2 errors, 0 warnings", "Build failed with 0 warnings"];
    for (const line of real) expect(first(line), line).toBe(line);
  });
});
