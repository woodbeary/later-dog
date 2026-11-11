import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { DECISION_MODELS, decisionCalls, decisionItems, type DecisionModel } from "./decision-eval/cases.ts";
import { extractionCalls, extractionFixture } from "./decision-eval/extraction.ts";
import { renderMarkdown, renderRuleLatency, scoreAll, timeRules, type Receipt } from "./decision-eval/score.ts";

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

function write(path: string, text: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, text);
}

function plan(): void {
  const out = argument("--out") ?? ".laterdog-scratch/decision-eval/requests.json";
  const models = (argument("--models")?.split(",") ?? [...DECISION_MODELS]).filter((model): model is DecisionModel =>
    (DECISION_MODELS as readonly string[]).includes(model));
  const calls = [...decisionCalls(decisionItems(), models), ...extractionCalls(extractionFixture())];
  write(out, JSON.stringify(calls));
  console.log(`${calls.length} requests written to ${out}`);
}

function receiptsGiven(): Receipt[] {
  const paths = (argument("--responses") ?? "").split(",").filter(Boolean);
  if (!paths.length) throw new Error("Supply --responses with one or more files, comma separated.");
  return paths.flatMap((path) => JSON.parse(readFileSync(path, "utf8")) as Receipt[]);
}

function emit(markdown: string): void {
  const markdownPath = argument("--markdown");
  if (markdownPath) write(markdownPath, markdown);
  else console.log(markdown);
}

function rules(): void {
  emit(renderRuleLatency(timeRules(decisionItems(), Number(argument("--repeats") ?? 200))));
}

async function probes(): Promise<void> {
  const { MADE_UP_INVALID_ANSWERS, renderProbes, replayProbes } = await import("./decision-eval/probes.ts");
  emit(renderProbes(await replayProbes([...receiptsGiven(), ...MADE_UP_INVALID_ANSWERS])));
}

function score(): void {
  const receipts = receiptsGiven();
  const results = scoreAll(receipts);
  const json = argument("--out");
  if (json) write(json, `${JSON.stringify(results, null, 1)}\n`);
  emit(renderMarkdown(results));
}

const command = process.argv[2];
if (command === "plan") plan();
else if (command === "score") score();
else if (command === "rules") rules();
else if (command === "probes") await probes();
else {
  console.error("Usage: decision-eval.ts plan [--out FILE] [--models clef,clef-flash] | score --responses FILE[,FILE] [--out FILE] [--markdown FILE] | rules [--repeats N] [--markdown FILE] | probes --responses FILE[,FILE] [--markdown FILE]");
  process.exitCode = 2;
}
