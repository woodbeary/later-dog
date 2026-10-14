import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fastCandidates, learnPhrases, pickFast, type PhraseBook } from "./typing-suggestions";

const RUNS = 2_000;
const FAST_P50_BUDGET_MS = 100;
const NOW = 1_800_000_000_000;

const verbs = ["fix", "check", "open", "review", "update", "deploy", "explain", "rename", "delete", "merge"];
const things = ["the failing tests", "the build", "a pull request", "the readme", "the login page", "the migration", "the docs", "that script", "the staging site", "my notes"];

function fullBook(): PhraseBook {
  let book: PhraseBook = [];
  let at = NOW;
  for (const verb of verbs) {
    for (const thing of things) {
      for (const lead of ["Can you", "Please", "Could you", "I need you to", "Go ahead and"]) {
        book = learnPhrases(book, `${lead} ${verb} ${thing}`, (at += 1));
      }
    }
  }
  return book;
}

const percentile = (samples: number[], p: number) => [...samples].sort((a, b) => a - b)[Math.min(samples.length - 1, Math.floor(samples.length * p))]!;

describe("how long the fast path takes with a full phrase book", () => {
  it("answers in well under 100 ms at the median, with no request", () => {
    const book = fullBook();
    expect(book.length).toBe(300);
    const pool = { phrases: book, dogNames: ["Rex", "Scout", "Maya", "Theo"], commands: ["/goal", "/learn", "/setup"] };
    const typed = book.map((phrase, index) => `${index % 7 === 0 ? "thanks. " : ""}${phrase.text.slice(0, 4 + (index % 9))}`);
    typed.push("ask Sc");
    const samples: number[] = [];
    let found = 0;
    for (let run = 0; run < RUNS; run += 1) {
      const text = typed[run % typed.length]!;
      const started = performance.now();
      const { best } = pickFast(fastCandidates(text, pool));
      samples.push(performance.now() - started);
      if (best) found += 1;
    }
    const report = {
      runs: RUNS,
      phrases: book.length,
      p50Ms: Math.round(percentile(samples, 0.5) * 1000) / 1000,
      p95Ms: Math.round(percentile(samples, 0.95) * 1000) / 1000,
      maxMs: Math.round(Math.max(...samples) * 1000) / 1000,
    };
    if (process.env.TYPING_BENCH_FAST_OUT) writeFileSync(process.env.TYPING_BENCH_FAST_OUT, JSON.stringify(report, null, 2));
    expect(found).toBe(RUNS);
    expect(report.p50Ms).toBeLessThan(FAST_P50_BUDGET_MS);
  });
});
