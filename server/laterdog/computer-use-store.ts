import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { TAKEOVER_REASONS } from "../../shared/takeover.ts";
import { rollbackQuietly } from "./safe-rollback.ts";
import { doneRuleSchema, type DoneRule, type DoneSource } from "./computer-use-done.ts";
import type { ScreenState } from "./computer-use-screen.ts";

export const RUN_STATES = ["running", "handed_over", "awaiting_done", "submission_unknown", "done", "failed"] as const;
export type RunState = typeof RUN_STATES[number];
export const FAILURE_CAUSES = ["not_done", "stopped", "timed_out", "step_limit", "refusal", "error", "interrupted"] as const;
export type FailureCause = typeof FAILURE_CAUSES[number];
export const HANDOFF_CAUSES = [...TAKEOVER_REASONS, "person", "confirm"] as const;
export type HandoffCause = typeof HANDOFF_CAUSES[number];
export const ASKED_BY = ["model", "person", "screen_check", "guard"] as const;
export const STEP_OUTCOMES = ["submission_unknown"] as const;
export const FAILURE_CLASSES = ["stale_screenshot", "missed_click", "wrong_field", "page_not_settled", "gave_up", "environment"] as const;
export type FailureClass = typeof FAILURE_CLASSES[number];
export type StepOutcome = typeof STEP_OUTCOMES[number];
export type AskedBy = typeof ASKED_BY[number];

export interface ComputerUseRun {
  id: string;
  startedAt: string;
  model: string;
  computerId: string;
  task: string;
  done: DoneRule;
  state: RunState;
  doneSource: DoneSource | null;
  failure: FailureCause | null;
  detail: string | null;
  endedAt: string | null;
  screenChecks: boolean;
}

export interface StepRecord {
  step: number;
  actions: Record<string, unknown>[];
  screenshotSha256: string;
  modelMs: number;
  actionMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  screenState?: ScreenState | null;
  screenProbability?: number | null;
  outcome?: StepOutcome | null;
  thinking?: string | null;
  screenUnchanged?: boolean | null;
}

export interface LoggedStep extends StepRecord {
  at: string;
  screenState: ScreenState | null;
  screenProbability: number | null;
  outcome: StepOutcome | null;
  thinking: string | null;
  screenUnchanged: boolean | null;
  failureClass: FailureClass | null;
}

export interface Handoff {
  number: number;
  at: string;
  cause: HandoffCause;
  askedBy: AskedBy;
  note: string;
  returnedAt: string | null;
  viewerUrl: string | null;
  viewerExpiresAt: string | null;
  probability: number | null;
}

export interface ViewerLink {
  url: string;
  expiresAt: string;
}

export type Outcome = { done: DoneSource; detail?: string } | { failed: FailureCause; detail?: string };

const OPEN: readonly RunState[] = ["running", "handed_over", "awaiting_done", "submission_unknown"];

export function isOpenRun(state: RunState): boolean {
  return OPEN.includes(state);
}

const ADDED_COLUMNS: Record<string, Record<string, string>> = {
  computer_use_runs: { screen_checks: "INTEGER NOT NULL DEFAULT 0" },
  computer_use_steps: { screen_state: "TEXT", screen_probability: "REAL", outcome: "TEXT", thinking: "TEXT", screen_unchanged: "INTEGER", failure_class: "TEXT" },
  computer_use_handoffs: { viewer_url: "TEXT", viewer_expires_at: "TEXT", probability: "REAL" },
};

function addMissingColumns(db: DatabaseSync): void {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const present = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name));
    for (const [column, type] of Object.entries(columns)) if (!present.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { status: 409 });
}

type RunRow = {
  id: string; started_at: string; model: string; computer_id: string; task: string; done_rule: string;
  state: RunState; done_source: DoneSource | null; failure: FailureCause | null; detail: string | null; ended_at: string | null;
  screen_checks: number;
};

function fromRow(row: RunRow): ComputerUseRun {
  return { id: row.id, startedAt: row.started_at, model: row.model, computerId: row.computer_id, task: row.task,
    done: doneRuleSchema.parse(JSON.parse(row.done_rule)), state: row.state, doneSource: row.done_source,
    failure: row.failure, detail: row.detail, endedAt: row.ended_at, screenChecks: row.screen_checks === 1 };
}

export class ComputerUseStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS computer_use_runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, model TEXT NOT NULL,
        computer_id TEXT NOT NULL, task TEXT NOT NULL, done_rule TEXT NOT NULL, state TEXT NOT NULL, done_source TEXT,
        failure TEXT, detail TEXT, ended_at TEXT);
      CREATE TABLE IF NOT EXISTS computer_use_steps (run_id TEXT NOT NULL, step INTEGER NOT NULL, at TEXT NOT NULL,
        actions TEXT NOT NULL, screenshot_sha256 TEXT NOT NULL, model_ms INTEGER NOT NULL, action_ms INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL, PRIMARY KEY (run_id, step));
      CREATE TABLE IF NOT EXISTS computer_use_handoffs (run_id TEXT NOT NULL, number INTEGER NOT NULL, at TEXT NOT NULL,
        cause TEXT NOT NULL, asked_by TEXT NOT NULL, note TEXT NOT NULL, returned_at TEXT, PRIMARY KEY (run_id, number));
    `);
    addMissingColumns(db);
  }

  #stamp(): string {
    return this.#now().toISOString();
  }

  #transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.#db.exec("COMMIT"); return result; }
    catch (error) { rollbackQuietly(this.#db); throw error; }
  }

  start(input: { task: string; computerId: string; model: string; done: DoneRule; screenChecks?: boolean }): ComputerUseRun {
    const done = doneRuleSchema.parse(input.done);
    const id = randomUUID();
    this.#db.prepare("INSERT INTO computer_use_runs(id,started_at,model,computer_id,task,done_rule,state,screen_checks) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, this.#stamp(), input.model, input.computerId, input.task, JSON.stringify(done), "running", input.screenChecks ? 1 : 0);
    return this.run(id);
  }

  run(id: string): ComputerUseRun {
    const row = this.#db.prepare("SELECT * FROM computer_use_runs WHERE id=?").get(id) as RunRow | undefined;
    if (!row) throw Object.assign(new Error("No computer-use run with that id."), { status: 404 });
    return fromRow(row);
  }

  runs(limit = 50): ComputerUseRun[] {
    return (this.#db.prepare("SELECT * FROM computer_use_runs ORDER BY started_at DESC, rowid DESC LIMIT ?").all(limit) as RunRow[]).map(fromRow);
  }

  step(runId: string, record: StepRecord): void {
    this.#db.prepare(`INSERT INTO computer_use_steps(run_id,step,at,actions,screenshot_sha256,model_ms,action_ms,input_tokens,output_tokens,
      cache_read_tokens,cache_write_tokens,screen_state,screen_probability,outcome,thinking,screen_unchanged) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, record.step, this.#stamp(),
      JSON.stringify(record.actions), record.screenshotSha256, record.modelMs, record.actionMs, record.inputTokens,
      record.outputTokens, record.cacheReadTokens, record.cacheWriteTokens, record.screenState ?? null, record.screenProbability ?? null, record.outcome ?? null,
      record.thinking ?? null, record.screenUnchanged === undefined || record.screenUnchanged === null ? null : Number(record.screenUnchanged));
  }

  screenAfter(runId: string, step: number, unchanged: boolean): void {
    this.#db.prepare("UPDATE computer_use_steps SET screen_unchanged=MAX(COALESCE(screen_unchanged,0),?) WHERE run_id=? AND step=?").run(Number(unchanged), runId, step);
  }

  classify(runId: string, step: number, failureClass: FailureClass | null): LoggedStep {
    if (failureClass !== null && !(FAILURE_CLASSES as readonly string[]).includes(failureClass)) throw Object.assign(new Error(`A failure class is one of ${FAILURE_CLASSES.join(", ")}.`), { status: 400 });
    const changed = this.#db.prepare("UPDATE computer_use_steps SET failure_class=? WHERE run_id=? AND step=?").run(failureClass, runId, step);
    if (!changed.changes) throw Object.assign(new Error("That run has no such step."), { status: 404 });
    return this.steps(runId).find((logged) => logged.step === step)!;
  }

  steps(runId: string): LoggedStep[] {
    type Row = { step: number; at: string; actions: string; screenshot_sha256: string; model_ms: number; action_ms: number;
      input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
      screen_state: ScreenState | null; screen_probability: number | null; outcome: StepOutcome | null; thinking: string | null;
      screen_unchanged: number | null; failure_class: FailureClass | null };
    return (this.#db.prepare("SELECT * FROM computer_use_steps WHERE run_id=? ORDER BY step").all(runId) as Row[]).map((row) => ({
      step: row.step, at: row.at, actions: JSON.parse(row.actions) as Record<string, unknown>[], screenshotSha256: row.screenshot_sha256,
      modelMs: row.model_ms, actionMs: row.action_ms, inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens, cacheWriteTokens: row.cache_write_tokens,
      screenState: row.screen_state, screenProbability: row.screen_probability, outcome: row.outcome, thinking: row.thinking,
      screenUnchanged: row.screen_unchanged === null ? null : row.screen_unchanged === 1, failureClass: row.failure_class,
    }));
  }

  handOver(runId: string, cause: HandoffCause, askedBy: AskedBy, note: string, probability: number | null = null): ComputerUseRun {
    if (!(HANDOFF_CAUSES as readonly string[]).includes(cause)) throw Object.assign(new Error(`A take-over cause is one of ${HANDOFF_CAUSES.join(", ")}.`), { status: 400 });
    return this.#transaction(() => {
      const run = this.run(runId);
      if (run.state === "handed_over") throw conflict("The person already has this run's screen.");
      if (run.state !== "running") throw conflict(`This run is ${run.state}, so there is no screen to take over.`);
      const { next } = this.#db.prepare("SELECT COALESCE(MAX(number),0)+1 AS next FROM computer_use_handoffs WHERE run_id=?").get(runId) as { next: number };
      this.#db.prepare("INSERT INTO computer_use_handoffs(run_id,number,at,cause,asked_by,note,probability) VALUES(?,?,?,?,?,?,?)")
        .run(runId, next, this.#stamp(), cause, askedBy, note.slice(0, 500), probability);
      this.#db.prepare("UPDATE computer_use_runs SET state='handed_over' WHERE id=?").run(runId);
      return this.run(runId);
    });
  }

  handBack(runId: string): ComputerUseRun {
    return this.#transaction(() => {
      const run = this.run(runId);
      if (run.state !== "handed_over") throw conflict("The person does not have this run's screen.");
      this.#closeHandoff(runId);
      this.#db.prepare("UPDATE computer_use_runs SET state='running' WHERE id=?").run(runId);
      return this.run(runId);
    });
  }

  #closeHandoff(runId: string): void {
    this.#db.prepare("UPDATE computer_use_handoffs SET returned_at=?, viewer_url=NULL WHERE run_id=? AND returned_at IS NULL").run(this.#stamp(), runId);
  }

  attachViewer(runId: string, number: number, link: ViewerLink): Handoff | null {
    this.#db.prepare("UPDATE computer_use_handoffs SET viewer_url=?, viewer_expires_at=? WHERE run_id=? AND number=? AND returned_at IS NULL")
      .run(link.url, link.expiresAt, runId, number);
    return this.handoffs(runId).find((handoff) => handoff.number === number) ?? null;
  }

  openHandoff(runId: string): Handoff | null {
    return this.handoffs(runId).find((handoff) => handoff.returnedAt === null) ?? null;
  }

  handoffs(runId: string): Handoff[] {
    type Row = { number: number; at: string; cause: HandoffCause; asked_by: AskedBy; note: string; returned_at: string | null;
      viewer_url: string | null; viewer_expires_at: string | null; probability: number | null };
    return (this.#db.prepare("SELECT * FROM computer_use_handoffs WHERE run_id=? ORDER BY number").all(runId) as Row[]).map((row) => ({
      number: row.number, at: row.at, cause: row.cause, askedBy: row.asked_by, note: row.note, returnedAt: row.returned_at,
      viewerUrl: row.viewer_url, viewerExpiresAt: row.viewer_expires_at, probability: row.probability,
    }));
  }

  awaitPerson(runId: string, detail: string, submissionUnknown = false): ComputerUseRun {
    return this.#transaction(() => {
      const run = this.run(runId);
      if (run.state !== "running" && run.state !== "handed_over") throw conflict(`This run is ${run.state}.`);
      this.#closeHandoff(runId);
      this.#db.prepare("UPDATE computer_use_runs SET state=?, detail=? WHERE id=?").run(submissionUnknown ? "submission_unknown" : "awaiting_done", detail.slice(0, 1000), runId);
      return this.run(runId);
    });
  }

  finish(runId: string, outcome: Outcome): ComputerUseRun {
    return this.#transaction(() => {
      const run = this.run(runId);
      if (!isOpenRun(run.state)) throw conflict(`This run already ended (${run.state}).`);
      if ("done" in outcome && outcome.done === "page_check" && !run.done.pageCheck) throw conflict("This run has no page check, so only the person can say it is done.");
      this.#closeHandoff(runId);
      const detail = outcome.detail?.slice(0, 1000) ?? run.detail;
      if ("done" in outcome) this.#db.prepare("UPDATE computer_use_runs SET state='done', done_source=?, detail=?, ended_at=? WHERE id=?").run(outcome.done, detail, this.#stamp(), runId);
      else this.#db.prepare("UPDATE computer_use_runs SET state='failed', failure=?, detail=?, ended_at=? WHERE id=?").run(outcome.failed, detail, this.#stamp(), runId);
      return this.run(runId);
    });
  }

  interrupted(): number {
    const open = (this.#db.prepare("SELECT id FROM computer_use_runs WHERE state IN ('running','handed_over')").all() as { id: string }[]).map((row) => row.id);
    for (const id of open) this.finish(id, { failed: "interrupted", detail: "The supervisor restarted while this run was going." });
    return open.length;
  }
}
