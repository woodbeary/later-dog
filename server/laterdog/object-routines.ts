import { capabilitySecret, signCapabilitySync } from "./signed-capability-node.ts";
import { DOG_CHAT, INBOX_ROUTE, ROUTINES_ROUTE, type InboxRequest, type ObjectRoutine, type Occurrence, type RoutinesAnswer, type RoutinesRequest } from "../../shared/dog-object-protocol.ts";
import { isObjectRun, type ObjectOccurrence, type Routine, type RoutineRun } from "../routines.ts";

const CALL_MS = 8_000;
const START_MS = 3_000;
const TOKEN_MS = 10 * 60_000;
const POLL_MS = 2_000;
const TERMINAL = new Set(["completed", "failed", "missed", "cancelled"]);

export interface DogObjectCallsOptions {
  origin: string;
  home: string;
  bootstrapSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class DogObjectCalls {
  private readonly secret: Buffer;
  private readonly send: typeof fetch;
  private readonly now: () => number;
  private readonly tokens = new Map<string, { value: string; expiresAt: number }>();
  private readonly options: DogObjectCallsOptions;

  constructor(options: DogObjectCallsOptions) {
    this.options = options;
    this.secret = capabilitySecret(options.bootstrapSecret);
    this.send = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  routines(dog: string, body: RoutinesRequest, budgetMs = CALL_MS): Promise<RoutinesAnswer> {
    return this.call(ROUTINES_ROUTE, dog, DOG_CHAT, body, budgetMs) as unknown as Promise<RoutinesAnswer>;
  }

  inbox(dog: string, chat: string, body: InboxRequest & { dog?: string }, budgetMs = CALL_MS): Promise<Record<string, unknown>> {
    return this.call(INBOX_ROUTE, dog, chat, body, budgetMs);
  }

  private bearer(dog: string, chat: string): string {
    const at = this.now();
    const key = `${dog}/${chat}`;
    const held = this.tokens.get(key);
    if (held && held.expiresAt - at > 60_000) return held.value;
    const value = signCapabilitySync(this.secret, { home: this.options.home, dog, chat, generation: "dog", kind: "turns", issuedAt: at, expiresAt: at + TOKEN_MS });
    this.tokens.set(key, { value, expiresAt: at + TOKEN_MS });
    return value;
  }

  private async call(route: string, dog: string, chat: string, body: unknown, budgetMs: number): Promise<Record<string, unknown>> {
    const response = await this.send(`${this.options.origin}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.bearer(dog, chat)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(budgetMs),
    });
    const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || answer.ok !== true) {
      throw Object.assign(new Error(`${route} answered ${response.status} ${String(answer.error ?? "")}`.trim()), { status: response.status });
    }
    return answer;
  }
}

export interface RoutineBook {
  routinesForBot(botId: string): Routine[];
  admitObjectOccurrence(occurrence: ObjectOccurrence): ObjectOccurrence["state"];
  mirrorObjectSchedules(views: ReadonlyArray<{ id: string; nextRunAt: number | null }>): number;
}

export interface ObjectRoutinesOptions {
  calls: Pick<DogObjectCalls, "routines">;
  book: () => RoutineBook | null;
  owned: (botId: string) => boolean;
  dogs: () => string[];
  timeZone: () => string;
  admitted?: () => void;
  now?: () => number;
  log?: (line: string) => void;
}

export function objectRoutine(routine: Routine): ObjectRoutine {
  return { id: routine.id, schedule: routine.schedule, nextRunAt: routine.nextRunAt, enabled: routine.enabled };
}

export class ObjectRoutines {
  private readonly options: ObjectRoutinesOptions;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly dueAt = new Map<string, number | null>();
  private readonly dirty = new Set<string>();
  private readonly settling = new Map<string, { dog: string; runId: string; state: "started" | "settled" }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  readonly state = { claims: 0, admitted: 0, settled: 0, failures: 0, lastError: null as string | null };

  constructor(options: ObjectRoutinesOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.warn(line));
  }

  start(): void {
    if (this.timer) return;
    for (const dog of this.options.dogs()) if (this.options.owned(dog)) this.dirty.add(dog);
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  changed(botId: string): void {
    if (this.options.owned(botId)) this.dirty.add(botId);
  }

  async beforeStart(run: RoutineRun): Promise<boolean> {
    if (!this.options.owned(run.botId) || !isObjectRun(run)) return true;
    try {
      await this.options.calls.routines(run.botId, { op: "settle", id: run.id, state: "started", runId: run.id }, START_MS);
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  runChanged(run: RoutineRun): void {
    if (!isObjectRun(run) || !TERMINAL.has(run.status)) return;
    this.settling.set(run.id, { dog: run.botId, runId: run.id, state: "settled" });
    this.dirty.add(run.botId);
  }

  async handBack(botId: string): Promise<number> {
    const book = this.options.book();
    if (!book) return 0;
    const exported = await this.options.calls.routines(botId, { op: "export" });
    this.admit(botId, book, exported.occurrences);
    this.dueAt.delete(botId);
    return book.mirrorObjectSchedules(exported.schedules);
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const book = this.options.book();
      if (!book) return;
      const now = this.now();
      for (const dog of this.options.dogs()) {
        if (!this.options.owned(dog)) continue;
        const due = this.dueAt.get(dog);
        if (!this.dirty.has(dog) && !(this.dueAt.has(dog) && due !== null && due !== undefined && due <= now)) continue;
        await this.sync(dog, book).catch((error) => this.fail(error));
      }
    } finally {
      this.polling = false;
    }
  }

  private async sync(dog: string, book: RoutineBook): Promise<void> {
    this.dirty.delete(dog);
    for (const [id, settle] of this.settling) {
      if (settle.dog !== dog) continue;
      await this.options.calls.routines(dog, { op: "settle", id, state: settle.state, runId: settle.runId }).catch((error: { status?: number }) => {
        if (error.status !== 409) throw error;
      });
      this.settling.delete(id);
      this.state.settled += 1;
    }
    const answer = await this.options.calls.routines(dog, { op: "put", timeZone: this.options.timeZone(), routines: book.routinesForBot(dog).map(objectRoutine) });
    this.state.claims += 1;
    const due = this.admit(dog, book, answer.occurrences);
    book.mirrorObjectSchedules(answer.schedules);
    if (due) this.options.admitted?.();
    const next = answer.schedules.filter((view) => view.enabled && view.nextRunAt !== null).map((view) => view.nextRunAt!);
    this.dueAt.set(dog, next.length ? Math.min(...next) : null);
  }

  private admit(dog: string, book: RoutineBook, occurrences: Occurrence[]): number {
    let due = 0;
    for (const occurrence of occurrences) {
      const state = book.admitObjectOccurrence(occurrence);
      this.state.admitted += 1;
      if (state === "due") due += 1;
      if (state === "settled" && occurrence.state !== "settled") {
        this.settling.set(occurrence.id, { dog, runId: occurrence.id, state: "settled" });
        this.dirty.add(dog);
      }
    }
    return due;
  }

  private fail(error: unknown): void {
    this.state.failures += 1;
    this.state.lastError = error instanceof Error ? error.message : String(error);
    this.log(`object routines: ${this.state.lastError}`);
  }
}
