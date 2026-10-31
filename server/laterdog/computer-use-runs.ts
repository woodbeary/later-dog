import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { COMPUTER_ID } from "./cloud-computers.ts";
import { anthropicMessages, type MessagesApi } from "./computer-use-anthropic.ts";
import { CloudDesktop } from "./computer-use-desktop.ts";
import { doneRuleSchema, livePageCheck, type PageCheck } from "./computer-use-done.ts";
import { DEFAULT_LIMITS, RunControl, runComputerUse, type LoopLimits, type UseDesktop } from "./computer-use-loop.ts";
import { ComputerUseStore, HANDOFF_CAUSES, type ComputerUseRun, type Handoff, type LoggedStep } from "./computer-use-store.ts";
import { INTERNAL_COMPUTERS_API, LaterdogComputers, computersApi } from "./laterdog-cloud.ts";

export const startRunSchema = z.object({
  task: z.string().trim().min(1).max(4000),
  computerId: z.string().regex(COMPUTER_ID),
  done: doneRuleSchema,
}).strict();
const takeOverSchema = z.object({ cause: z.enum(HANDOFF_CAUSES).default("person"), note: z.string().trim().max(500).default("") }).strict();
const runId = z.string().uuid();

export interface ComputerUseEngine {
  messages: MessagesApi;
  desktop(computerId: string): UseDesktop;
  pageCheck: PageCheck;
  clock?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  limits?: LoopLimits;
}

export interface RunView {
  run: ComputerUseRun;
  steps: LoggedStep[];
  handoffs: Handoff[];
}

const waitFor = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

function unavailable(message: string): Error {
  return Object.assign(new Error(message), { status: 409 });
}

export class ComputerUseRuns {
  readonly store: ComputerUseStore;
  readonly #engine: ComputerUseEngine | null;
  readonly #unavailable: string;
  readonly #live = new Map<string, { control: RunControl; finished: Promise<ComputerUseRun> }>();

  constructor(store: ComputerUseStore, engine: ComputerUseEngine | { unavailable: string }) {
    this.store = store;
    this.#engine = "unavailable" in engine ? null : engine;
    this.#unavailable = "unavailable" in engine ? engine.unavailable : "";
    store.interrupted();
  }

  start(body: unknown): ComputerUseRun {
    const engine = this.#engine;
    if (!engine) throw unavailable(this.#unavailable);
    const input = startRunSchema.parse(body);
    const run = this.store.start({ ...input, model: engine.messages.model });
    const control = new RunControl();
    const finished = runComputerUse(run.id, {
      store: this.store, desktop: engine.desktop(run.computerId), messages: engine.messages, control, pageCheck: engine.pageCheck,
      clock: engine.clock ?? Date.now, sleep: engine.sleep ?? waitFor, limits: engine.limits ?? DEFAULT_LIMITS,
    }).finally(() => this.#live.delete(run.id));
    finished.catch(() => {});
    this.#live.set(run.id, { control, finished });
    return run;
  }

  #end(id: string, outcome: Parameters<ComputerUseStore["finish"]>[1]): ComputerUseRun {
    const run = this.store.finish(id, outcome);
    this.#live.get(id)?.control.end();
    return run;
  }

  done(id: string): ComputerUseRun {
    return this.#end(id, { done: "person", detail: "The person tapped Done." });
  }

  notDone(id: string): ComputerUseRun {
    return this.#end(id, { failed: "not_done", detail: "The person said it is not done." });
  }

  stop(id: string): ComputerUseRun {
    return this.#end(id, { failed: "stopped", detail: "The person stopped the run." });
  }

  takeOver(id: string, body: unknown): ComputerUseRun {
    const input = takeOverSchema.parse(body ?? {});
    const live = this.#live.get(id);
    if (!live) throw unavailable("This run is not going on this supervisor now, so there is no screen to take over.");
    const run = this.store.handOver(id, input.cause, "person", input.note);
    live.control.hold();
    return run;
  }

  handBack(id: string): ComputerUseRun {
    const run = this.store.handBack(id);
    this.#live.get(id)?.control.release();
    return run;
  }

  view(id: string): RunView {
    return { run: this.store.run(id), steps: this.store.steps(id), handoffs: this.store.handoffs(id) };
  }

  list(limit = 50): ComputerUseRun[] {
    return this.store.runs(limit);
  }

  finished(id: string): Promise<ComputerUseRun> {
    return this.#live.get(id)?.finished ?? Promise.resolve(this.store.run(id));
  }

  async drain(): Promise<void> {
    const live = [...this.#live.entries()];
    for (const [id] of live) {
      try { this.#end(id, { failed: "interrupted", detail: "The supervisor stopped while this run was going." }); } catch {}
    }
    await Promise.allSettled(live.map(([, entry]) => entry.finished));
  }
}

export type RouteAnswer = { status: number; body: unknown } | null;
const RUNS_PATH = /^\/v1\/computer-runs(?:\/([\w-]+)(?:\/(done|not-done|stop|take-over|hand-back))?)?$/;

export async function computerUseRoute(runs: ComputerUseRuns | undefined, method: string, pathname: string, body: () => Promise<unknown>): Promise<RouteAnswer> {
  const match = RUNS_PATH.exec(pathname);
  if (!match) return null;
  if (!runs) return { status: 409, body: { error: "Computer-use runs are not set up on this supervisor." } };
  const [, rawId, verb] = match;
  if (!rawId) {
    if (method === "POST") return { status: 202, body: { run: runs.start(await body()) } };
    if (method === "GET") return { status: 200, body: { runs: runs.list() } };
    return null;
  }
  const id = runId.parse(rawId);
  if (!verb) return method === "GET" ? { status: 200, body: runs.view(id) } : null;
  if (method !== "POST") return null;
  if (verb === "done") return { status: 200, body: { run: runs.done(id) } };
  if (verb === "not-done") return { status: 200, body: { run: runs.notDone(id) } };
  if (verb === "stop") return { status: 200, body: { run: runs.stop(id) } };
  if (verb === "take-over") return { status: 200, body: { run: runs.takeOver(id, await body()) } };
  return { status: 200, body: { run: runs.handBack(id) } };
}

export function computerUseRunsFromEnvironment(db: DatabaseSync, env: NodeJS.ProcessEnv): ComputerUseRuns {
  const store = new ComputerUseStore(db);
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return new ComputerUseRuns(store, { unavailable: "Claude computer use needs ANTHROPIC_API_KEY in the supervisor's environment." });
  try {
    const computersKey = env.LATERDOG_COMPUTERS_KEY?.trim();
    if (computersKey && !/^ldc_[!-~]{8,1024}$/.test(computersKey)) throw new Error("LATERDOG_COMPUTERS_KEY does not hold a later.dog computers key (they start with ldc_)");
    const computers = new LaterdogComputers({ api: computersApi(env.LATERDOG_COMPUTERS_URL?.trim() || INTERNAL_COMPUTERS_API), ...(computersKey ? { key: computersKey } : {}) }, fetch);
    return new ComputerUseRuns(store, { messages: anthropicMessages(apiKey), desktop: (id) => new CloudDesktop(computers, id), pageCheck: livePageCheck() });
  } catch (error) {
    return new ComputerUseRuns(store, { unavailable: error instanceof Error ? error.message : String(error) });
  }
}
