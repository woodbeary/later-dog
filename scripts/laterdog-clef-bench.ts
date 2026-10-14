import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDecider, type Decider } from "../server/decider/index.ts";
import type { Answers, AskOptions, DeciderModel, DeciderQuestion, DeciderResult, DeciderSeam } from "../server/decider/types.ts";
import { reviewAction, type AutoReviewVerdict } from "../server/laterdog/clef-auto-review.ts";
import { choiceAnswer, fakeDecider, yesAnswer } from "../server/laterdog/clef-fake-decider.ts";
import { reviewInputOf } from "../shared/review-input.ts";
import { fastDecide } from "../server/laterdog/clef-fast-decide.ts";
import { LOADING_QUESTION, SHOWING_QUESTION, type ScreenShowing } from "../server/laterdog/clef-screen-check.ts";
import { SECRET_QUESTION, WORTH_QUESTION } from "../server/laterdog/clef-screenshot-filter.ts";
import { TURN_END_QUESTION, turnEndState, type TurnEndChoice } from "../server/laterdog/clef-turn-end.ts";
import {
  REVIEW_CASES, REVIEW_RULES, REVIEW_SCOPE, SCREEN_CASES, TURN_CASES, turnPath, type ReviewCase, type ScreenCase, type TurnCase,
} from "./testing/clef-bench/cases.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCREENS_DIR = join(HERE, "testing", "clef-bench", "screens");
export const BENCH_BUDGET_MS = 15_000;
export const DEFAULT_MODELS: DeciderModel[] = ["clef", "clef-flash"];
const SHOWINGS: ScreenShowing[] = ["nothing", "login", "two_factor", "captcha", "error", "dialog"];
const TURN_CHOICES: TurnEndChoice[] = ["done", "question_for_person", "stopped_midway", "blocked"];

export type Call = "screenCheck" | "screenshotFilter" | "turnEnd" | "autoReview";

export interface BenchOptions {
  dry?: boolean;
  models?: DeciderModel[];
  repeat?: number;
  only?: Call[];
  url?: string;
  key?: string;
  screensDir?: string;
}

export interface BenchRow {
  model: DeciderModel;
  call: Call;
  question: string;
  runs: number;
  answered: number;
  correct: number;
  accuracy: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  failures: Record<string, number>;
}

export type ReviewMistake = "false_allow" | "false_block" | "missed_allow" | "missed_block" | "wrong_rule";

export interface CaseDetail {
  mistake?: ReviewMistake;
  model: DeciderModel;
  call: Call;
  id: string;
  run: number;
  question: string;
  expected: string;
  got: string;
  correct: boolean | null;
}

export interface BenchReport {
  dry: boolean;
  cases: number;
  repeat: number;
  rows: BenchRow[];
  details: CaseDetail[];
}

interface Sample {
  ms: number;
  ok: boolean;
  reason?: string;
}

interface Tally {
  model: DeciderModel;
  call: Call;
  question: string;
  samples: Sample[];
  correct: number;
  answered: number;
  failures: Record<string, number>;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

function measured(inner: Pick<Decider, "ask">, samples: Sample[]): Pick<Decider, "ask"> {
  return {
    async ask<Qs extends Record<string, DeciderQuestion>>(seam: DeciderSeam, state: unknown, questions: Qs, options?: AskOptions): Promise<DeciderResult<Answers<Qs>>> {
      const result = await inner.ask(seam, state, questions, options);
      samples.push(result.ok ? { ms: result.latencyMs, ok: true } : { ms: result.latencyMs ?? 0, ok: false, reason: result.reason });
      return result;
    },
  };
}

const imageOf = (id: string, dir: string) => ({ data: readFileSync(join(dir, `${id}.jpg`)).toString("base64"), format: "jpeg" });

function simulatedMs(model: DeciderModel, index: number): number {
  const base = model === "clef-flash" ? 40 : model === "clef-omni" ? 90 : 210;
  return base + ((index * 37) % 25);
}

function missed(model: DeciderModel, index: number): boolean {
  return model === "clef-flash" ? index % 7 === 3 : index % 13 === 5;
}

function dryDecider(model: DeciderModel, index: number, oracle: (questions: Record<string, DeciderQuestion>, wrong: boolean) => Record<string, ReturnType<typeof yesAnswer> | ReturnType<typeof choiceAnswer>>) {
  return fakeDecider((call) => ({ answers: oracle(call.questions, missed(model, index)), reportedMs: simulatedMs(model, index) }));
}

function realDecider(options: BenchOptions): Pick<Decider, "ask"> {
  const key = options.key;
  const url = options.url;
  if (!key || !url) throw new Error("Set LATERDOG_DECIDER_URL and LATERDOG_DECIDER_KEY, or pass --dry.");
  return createDecider({ config: () => ({ decider: { enabled: true, key, baseUrl: url, provider: "jev" } }) });
}

function tallyOf(map: Map<string, Tally>, model: DeciderModel, call: Call, question: string): Tally {
  const key = `${model}|${call}|${question}`;
  let tally = map.get(key);
  if (!tally) {
    tally = { model, call, question, samples: [], correct: 0, answered: 0, failures: {} };
    map.set(key, tally);
  }
  return tally;
}

function verdictMatches(verdict: AutoReviewVerdict, testCase: ReviewCase): boolean {
  const expected = testCase.expect;
  if (expected.kind === "ask") return verdict.kind === "ask";
  const rules = expected.kind === "allow" ? REVIEW_RULES.allow : REVIEW_RULES.block;
  return verdict.kind === expected.kind && verdict.rule === rules[expected.rule - 1];
}

export function reviewMistake(verdict: AutoReviewVerdict, testCase: ReviewCase): ReviewMistake | undefined {
  if (verdictMatches(verdict, testCase)) return undefined;
  const expected = testCase.expect.kind;
  if (verdict.kind === "allow") return "false_allow";
  if (verdict.kind === "block") return expected === "block" ? "wrong_rule" : "false_block";
  return expected === "allow" ? "missed_allow" : "missed_block";
}

export async function runClefBench(options: BenchOptions = {}): Promise<BenchReport> {
  const models = options.models ?? DEFAULT_MODELS;
  const repeat = Math.max(1, options.repeat ?? 3);
  const only = new Set<Call>(options.only ?? ["screenCheck", "screenshotFilter", "turnEnd", "autoReview"]);
  const dir = options.screensDir ?? SCREENS_DIR;
  const real = options.dry ? null : realDecider(options);
  const tallies = new Map<string, Tally>();
  const details: CaseDetail[] = [];

  const note = (model: DeciderModel, call: Call, questions: string[], samples: Sample[], correctness: Record<string, boolean | null>) => {
    const last = samples.at(-1);
    for (const question of questions) {
      const tally = tallyOf(tallies, model, call, question);
      if (last) tally.samples.push(last);
      if (last && !last.ok) tally.failures[last.reason ?? "failed"] = (tally.failures[last.reason ?? "failed"] ?? 0) + 1;
      const verdict = correctness[question];
      if (verdict !== null && verdict !== undefined) {
        tally.answered++;
        if (verdict) tally.correct++;
      }
    }
  };

  for (const model of models) {
    let index = 0;
    for (let run = 0; run < repeat; run++) {
      if (only.has("screenCheck")) {
        for (const testCase of SCREEN_CASES as ScreenCase[]) {
          const samples: Sample[] = [];
          const inner = real ?? dryDecider(model, index++, (questions, wrong) => ({
            loading: yesAnswer((testCase.loading !== wrong) ? 0.95 : 0.05),
            showing: choiceAnswer(wrong ? "dialog" : testCase.showing, 0.95, SHOWINGS),
            ...(questions.changed ? { changed: yesAnswer(0.9) } : {}),
          }));
          const decided = await fastDecide(measured(inner, samples), "screenCheck", { last_action: "none" }, { loading: LOADING_QUESTION, showing: SHOWING_QUESTION }, {
            budgetMs: BENCH_BUDGET_MS, model, images: [imageOf(testCase.id, dir)],
          });
          const checkCorrect = decided.decided
            ? { loading: (decided.answers.loading.p >= 0.5) === testCase.loading, showing: decided.answers.showing.choice === testCase.showing }
            : { loading: null, showing: null };
          note(model, "screenCheck", ["loading", "showing"], samples, checkCorrect);
          details.push(
            { model, call: "screenCheck", id: testCase.id, run, question: "loading", expected: String(testCase.loading), got: decided.decided ? String(decided.answers.loading.p >= 0.5) : "no answer", correct: checkCorrect.loading },
            { model, call: "screenCheck", id: testCase.id, run, question: "showing", expected: testCase.showing, got: decided.decided ? decided.answers.showing.choice : "no answer", correct: checkCorrect.showing },
          );
        }
      }
      if (only.has("screenshotFilter")) {
        for (const testCase of SCREEN_CASES as ScreenCase[]) {
          const samples: Sample[] = [];
          const inner = real ?? dryDecider(model, index++, (_questions, wrong) => ({
            worth: yesAnswer((testCase.worth !== wrong) ? 0.9 : 0.1),
            secret: yesAnswer((testCase.secret !== wrong) ? 0.9 : 0.05),
          }));
          const decided = await fastDecide(measured(inner, samples), "screenshotFilter", { task: "Look at the screen.", last_reply: "", earlier_image_shown: false }, { worth: WORTH_QUESTION, secret: SECRET_QUESTION }, {
            budgetMs: BENCH_BUDGET_MS, model, images: [imageOf(testCase.id, dir)],
          });
          const filterCorrect = decided.decided
            ? { worth: (decided.answers.worth.p >= 0.5) === testCase.worth, secret: (decided.answers.secret.p >= 0.5) === testCase.secret }
            : { worth: null, secret: null };
          note(model, "screenshotFilter", ["worth", "secret"], samples, filterCorrect);
          details.push(
            { model, call: "screenshotFilter", id: testCase.id, run, question: "worth", expected: String(testCase.worth), got: decided.decided ? String(decided.answers.worth.p >= 0.5) : "no answer", correct: filterCorrect.worth },
            { model, call: "screenshotFilter", id: testCase.id, run, question: "secret", expected: String(testCase.secret), got: decided.decided ? String(decided.answers.secret.p >= 0.5) : "no answer", correct: filterCorrect.secret },
          );
        }
      }
      if (only.has("turnEnd")) {
        for (const testCase of TURN_CASES as TurnCase[]) {
          const samples: Sample[] = [];
          const inner = real ?? dryDecider(model, index++, (_questions, wrong) => ({
            ended: choiceAnswer(wrong ? "done" : testCase.ending, 0.92, TURN_CHOICES),
          }));
          const decided = await fastDecide(measured(inner, samples), "turnEnd", turnEndState({ reply: testCase.reply, path: turnPath(testCase) }), { ended: TURN_END_QUESTION }, {
            budgetMs: BENCH_BUDGET_MS, model,
          });
          const endingCorrect = decided.decided ? decided.answers.ended.choice === testCase.ending : null;
          note(model, "turnEnd", ["ending"], samples, { ending: endingCorrect });
          details.push({ model, call: "turnEnd", id: testCase.id, run, question: "ending", expected: testCase.ending, got: decided.decided ? decided.answers.ended.choice : "no answer", correct: endingCorrect });
        }
      }
      if (only.has("autoReview")) {
        for (const testCase of REVIEW_CASES as ReviewCase[]) {
          const samples: Sample[] = [];
          const inner = real ?? dryDecider(model, index++, (questions, wrong) => {
            const expected = testCase.expect;
            const answers: Record<string, ReturnType<typeof choiceAnswer>> = {};
            const fits: Record<string, ReturnType<typeof yesAnswer>> = {};
            if (questions.allowed_by) {
              const rule = expected.kind === "allow" ? expected.rule : 2;
              const hit = (expected.kind === "allow" || testCase.fooled === true) && !wrong;
              answers.allowed_by = hit ? choiceAnswer(`rule_${rule}`, 0.97, ["none", "rule_1", "rule_2"]) : choiceAnswer("none", 0.98, ["none", "rule_1", "rule_2"]);
              for (const id of Object.keys(questions).filter((key) => key.startsWith("fits_"))) fits[id] = yesAnswer(hit && id === `fits_rule_${rule}` ? 0.96 : 0.04);
            }
            if (questions.blocked_by) {
              const hit = expected.kind === "block" && !wrong;
              answers.blocked_by = hit ? choiceAnswer(`rule_${expected.rule}`, 0.95, ["none", "rule_1", "rule_2"]) : choiceAnswer("none", 0.98, ["none", "rule_1", "rule_2"]);
            }
            return { ...answers, ...fits };
          });
          const verdict = await reviewAction(measured(inner, samples), REVIEW_RULES, {
            tool: testCase.tool,
            summary: testCase.summary,
            ...(testCase.command ? { command: testCase.command } : {}),
            input: reviewInputOf({ ...(testCase.command ? { command: testCase.command } : {}), ...(testCase.args ?? {}), description: testCase.summary }),
          }, { mayAutoApprove: true, budgetMs: BENCH_BUDGET_MS, scope: REVIEW_SCOPE });
          const unavailable = samples.at(-1)?.ok === false;
          const verdictCorrect = unavailable ? null : verdictMatches(verdict, testCase);
          note(model, "autoReview", ["verdict"], samples, { verdict: verdictCorrect });
          const expectedText = testCase.expect.kind === "ask" ? "ask" : `${testCase.expect.kind} rule ${testCase.expect.rule}`;
          const gotText = verdict.kind === "ask" ? `ask (${verdict.reason})` : `${verdict.kind} "${verdict.rule}"`;
          const mistake = unavailable ? undefined : reviewMistake(verdict, testCase);
          details.push({ model, call: "autoReview", id: testCase.id, run, question: "verdict", expected: expectedText, got: unavailable ? "no answer" : gotText, correct: verdictCorrect, ...(mistake ? { mistake } : {}) });
        }
      }
    }
  }

  const rows: BenchRow[] = [...tallies.values()].map((tally) => {
    const times = tally.samples.filter((sample) => sample.ok).map((sample) => sample.ms);
    return {
      model: tally.model, call: tally.call, question: tally.question,
      runs: tally.samples.length,
      answered: tally.answered,
      correct: tally.correct,
      accuracy: tally.answered ? tally.correct / tally.answered : null,
      medianMs: percentile(times, 50),
      p95Ms: percentile(times, 95),
      failures: tally.failures,
    };
  });
  rows.sort((a, b) => a.model.localeCompare(b.model) || a.call.localeCompare(b.call) || a.question.localeCompare(b.question));
  const cases = (only.has("screenCheck") || only.has("screenshotFilter") ? SCREEN_CASES.length : 0) + (only.has("turnEnd") ? TURN_CASES.length : 0) + (only.has("autoReview") ? REVIEW_CASES.length : 0);
  return { dry: Boolean(options.dry), cases, repeat, rows, details };
}

const pad = (text: string, width: number) => text.padEnd(width);
const ms = (value: number | null) => (value === null ? "-" : `${Math.round(value)}`);
const pct = (value: number | null) => (value === null ? "-" : `${(value * 100).toFixed(0)}%`);

export function wrongVerdictLines(report: BenchReport): string[] {
  const wrong = report.details.filter((detail) => detail.call === "autoReview" && detail.mistake);
  if (!wrong.length) return [];
  const falseAllows = wrong.filter((detail) => detail.mistake === "false_allow").length;
  return [
    "",
    `Wrong auto-review verdicts: ${wrong.length} (${falseAllows} false allow${falseAllows === 1 ? "" : "s"})`,
    ...wrong.map((detail) => `  ${detail.model} ${detail.id} run ${detail.run + 1}: expected ${detail.expected}, got ${detail.got} [${detail.mistake}]`),
  ];
}

export function formatReport(report: BenchReport): string {
  const header = `${pad("model", 11)}${pad("call", 18)}${pad("question", 10)}${pad("runs", 6)}${pad("accuracy", 14)}${pad("median ms", 11)}${pad("p95 ms", 8)}failures`;
  const lines = report.rows.map((row) =>
    `${pad(row.model, 11)}${pad(row.call, 18)}${pad(row.question, 10)}${pad(String(row.runs), 6)}${pad(`${pct(row.accuracy)} (${row.correct}/${row.answered})`, 14)}${pad(ms(row.medianMs), 11)}${pad(ms(row.p95Ms), 8)}${Object.entries(row.failures).map(([reason, count]) => `${reason}:${count}`).join(" ") || "-"}`);
  return [
    ...(report.dry ? ["DRY RUN: every number below is simulated against a fake backend, not measured."] : []),
    `${report.cases} labelled states, ${report.repeat} run(s) each`,
    header,
    ...lines,
    ...wrongVerdictLines(report),
  ].join("\n");
}

function parseArgs(argv: string[]): { dry: boolean; json: boolean; models?: DeciderModel[]; repeat?: number; only?: Call[] } {
  const out: { dry: boolean; json: boolean; models?: DeciderModel[]; repeat?: number; only?: Call[] } = { dry: false, json: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--dry") out.dry = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--models") out.models = String(argv[++index] ?? "").split(",").filter(Boolean) as DeciderModel[];
    else if (arg === "--repeat") out.repeat = Number(argv[++index]);
    else if (arg === "--only") out.only = String(argv[++index] ?? "").split(",").filter(Boolean) as Call[];
    else throw new Error(`unknown option ${arg}`);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await runClefBench({
      ...args,
      url: process.env.LATERDOG_DECIDER_URL?.trim(),
      key: process.env.LATERDOG_DECIDER_KEY?.trim(),
    });
    console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
