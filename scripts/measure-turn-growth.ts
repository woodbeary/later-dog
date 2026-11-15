import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleComputerRun } from "../server/laterdog/computer-run-route.ts";
import { ComputerRuns, OUTPUT_TAIL_CHARS, type RunBox } from "../server/laterdog/computer-runs.ts";

const tokens = (bytes: number) => Math.ceil(bytes / 4);
const STARTING_CONTEXT_TOKENS = 35_000;
const CALL_TOKENS = 60;
const JOB_MINUTES = 56;
const READS = 14;
const WHOLE_READ_LINES = 2_000;
const WHOLE_READ_CAP_TOKENS = 25_000;
const PART_LINES = 120;
const LANE_STEPS = 200;
const STEP_TOKENS = 2_000;
const COMPACTED_TOKENS = 20_000;

export interface Steps { calls: number; contexts: number[] }

function walk(added: readonly number[], start = STARTING_CONTEXT_TOKENS): Steps {
  const contexts: number[] = [];
  let context = start;
  for (const step of added) {
    contexts.push(context);
    context += CALL_TOKENS + step;
  }
  contexts.push(context);
  return { calls: added.length, contexts };
}

const sent = (steps: Steps) => steps.contexts.slice(0, -1).reduce((sum, context) => sum + context, 0);
const last = (steps: Steps) => steps.contexts.at(-1) ?? 0;

async function waitForJob(body: Record<string, unknown>, maxWaitMs?: number): Promise<number[]> {
  const root = mkdtempSync(join(tmpdir(), "laterdog-turn-growth-"));
  try {
    mkdirSync(join(root, "site"), { recursive: true });
    writeFileSync(join(root, "site/check.ts"), "export const check = 1;\n");
    const clock = { at: 1_000_000 };
    const endsAt = clock.at + JOB_MINUTES * 60_000;
    const log = Array.from({ length: 400 }, (_, i) => ` ✓ fixture test ${i} passes in ${i % 97} ms`).join("\n").slice(-OUTPUT_TAIL_CHARS);
    const box: RunBox = {
      async exec(command) {
        if (command.startsWith("cat runs/.logs/")) return { exitCode: 0, stdout: clock.at >= endsAt ? `0\n<<<\n${log}` : `<<<\n${log}`, stderr: "" };
        if (command.includes("nohup")) return { exitCode: 0, stdout: "started\n", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async write() {},
      async read() { return Buffer.alloc(0); },
    };
    const runs = new ComputerRuns(join(root, "state"), { now: () => clock.at, sleep: async (ms) => { clock.at += ms; } });
    const computer = async () => ({ box });
    const results: number[] = [];
    let ask: Record<string, unknown> = { command: "pnpm gate", folder: join(root, "site"), ...body };
    for (let call = 0; call < 100; call += 1) {
      const answer = await handleComputerRun({ botId: "dog", body: ask, workingFolder: null, allowedRoots: [], home: root, ...(maxWaitMs ? { maxWaitMs } : {}) }, { runs, computer, now: () => clock.at });
      const text = answer.text ?? answer.error ?? "";
      results.push(tokens(Buffer.byteLength(text)));
      const still = /^Still running.*run_id ([0-9a-f]{8})/.exec(text);
      if (!still) break;
      ask = { run_id: still[1], ...body };
    }
    return results;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fileReads(path: string): { whole: number[]; parts: number[] } {
  const lines = readFileSync(path, "utf8").split("\n");
  const whole = Math.min(WHOLE_READ_CAP_TOKENS, tokens(Buffer.byteLength(lines.slice(0, WHOLE_READ_LINES).join("\n"))));
  const step = Math.max(1, Math.floor((lines.length - PART_LINES) / READS));
  const parts = Array.from({ length: READS }, (_, i) => tokens(Buffer.byteLength(lines.slice(i * step, i * step + PART_LINES).join("\n"))));
  return { whole: Array.from({ length: READS }, () => whole), parts };
}

async function helperLane(): Promise<{ oneTurn: Steps; turns: Steps[] }> {
  const added = Array.from({ length: LANE_STEPS }, () => STEP_TOKENS);
  const oneTurn = walk(added);
  const budget = await import("../server/laterdog/turn-budget.ts").catch(() => null);
  if (!budget) return { oneTurn, turns: [oneTurn] };
  const turns: Steps[] = [];
  let done = 0;
  let start = STARTING_CONTEXT_TOKENS;
  while (done < LANE_STEPS) {
    const watch = new budget.HelperTurnBudget();
    watch.begin("lane");
    const steps: number[] = [];
    let context = start;
    while (done < LANE_STEPS) {
      steps.push(STEP_TOKENS);
      done += 1;
      context += CALL_TOKENS + STEP_TOKENS;
      if (watch.toolUsed("lane", context)) break;
    }
    turns.push(walk(steps, start));
    start = COMPACTED_TOKENS;
  }
  return { oneTurn, turns };
}

function row(name: string, steps: Steps | Steps[]): string {
  const all = Array.isArray(steps) ? steps : [steps];
  const calls = all.reduce((sum, s) => sum + s.calls, 0);
  const peak = Math.max(...all.map(last));
  const total = all.reduce((sum, s) => sum + sent(s), 0);
  return `| ${name} | ${calls} | ${all.length} | ${peak.toLocaleString("en-US")} | ${total.toLocaleString("en-US")} |`;
}

export async function measure(serverFile: string): Promise<string> {
  const polled = await waitForJob({});
  const waited = await waitForJob({ wait_minutes: 60 });
  const reads = fileReads(serverFile);
  const lane = await helperLane();
  return [
    `Fixture: a dog starts at ${STARTING_CONTEXT_TOKENS.toLocaleString("en-US")} tokens of context; each tool call adds ${CALL_TOKENS} tokens plus its result, and every call re-sends the whole context. Tokens are bytes / 4.`,
    "",
    "| case | tool calls | turns | context at the end | tokens sent over the case |",
    "|---|---|---|---|---|",
    row(`wait for a ${JOB_MINUTES}-minute job, run_on_computer as a dog calls it today`, walk(polled)),
    row(`wait for a ${JOB_MINUTES}-minute job, run_on_computer with wait_minutes 60`, walk(waited)),
    row(`read ${serverFile.split("/").at(-1)} whole ${READS} times`, walk(reads.whole)),
    row(`read ${READS} parts of ${PART_LINES} lines of it`, walk(reads.parts)),
    row(`a helper lane of ${LANE_STEPS} steps of ${STEP_TOKENS.toLocaleString("en-US")} tokens in one turn`, lane.oneTurn),
    row(`the same lane with the helper turn bound, compacted to ${COMPACTED_TOKENS.toLocaleString("en-US")} tokens between turns`, lane.turns),
  ].join("\n");
}

if (import.meta.main) console.log(await measure(process.argv[2] ?? join(import.meta.dirname, "../server/index.ts")));
