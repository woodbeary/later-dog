import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { COMPUTER_ID } from "./cloud-computers.ts";
import { anthropicMessages, fixtureMessagesUrl, type MessagesApi } from "./computer-use-anthropic.ts";
import { clefScreenChecks, type ScreenChecks } from "./computer-use-screen.ts";
import { CloudDesktop } from "./computer-use-desktop.ts";
import { doneRuleSchema, livePageCheck, type PageCheck } from "./computer-use-done.ts";
import { DEFAULT_LIMITS, handOverScreen, RunControl, runComputerUse, type FormNotice, type LoopLimits, type TakeoverNotice, type UseDesktop } from "./computer-use-loop.ts";
import { RunSecureForms, type RunFormView } from "./computer-use-secure-form.ts";
import { ComputerUseStore, FAILURE_CLASSES, HANDOFF_CAUSES, type ComputerUseRun, type Handoff, type LoggedStep } from "./computer-use-store.ts";
import { INTERNAL_COMPUTERS_API, LaterdogComputers, computersApi } from "./laterdog-cloud.ts";
import { phonePushRequest, type PhonePush } from "./phone-push.ts";
import type { Notification } from "../notify.ts";

export const startRunSchema = z.object({
  task: z.string().trim().min(1).max(4000),
  computerId: z.string().regex(COMPUTER_ID),
  done: doneRuleSchema,
}).strict();
const takeOverSchema = z.object({ cause: z.enum(HANDOFF_CAUSES).default("person"), note: z.string().trim().max(500).default("") }).strict();
const runId = z.string().uuid();
const handBackSchema = z.object({ approve: z.boolean().default(false) }).strict();
const formId = z.string().regex(/^form_[a-f0-9]{16}$/);
const secureFormSchema = z.union([
  z.object({ formId, values: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.string().max(512)) }).strict(),
  z.object({ formId, cancel: z.literal(true) }).strict(),
]);

export interface ComputerUseEngine {
  messages: MessagesApi;
  desktop(computerId: string): UseDesktop;
  pageCheck: PageCheck;
  screenChecks?: ScreenChecks;
  clock?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  limits?: LoopLimits;
}

export interface ComputerUseOptions {
  phone?: PhonePush;
}

const CAUSE_WORDS: Record<string, string> = {
  "sign-in": "a sign-in", captcha: "a CAPTCHA", payment: "a payment", other: "a step only you can do", person: "you",
};

export function formNotification(notice: FormNotice): Notification {
  return {
    kind: "takeover", botId: "", botName: "later.dog", threadId: "", computerRunId: notice.runId,
    title: "Computer use needs your details",
    body: `${notice.form.title} (${notice.form.host}). Open later.dog to fill in the Secure Form.`.slice(0, 200),
  };
}

export function takeoverNotification(notice: TakeoverNotice): Notification {
  const { handoff } = notice;
  return {
    kind: "takeover", botId: "", botName: "later.dog", threadId: "", computerRunId: notice.runId,
    title: "Computer use needs your hands",
    body: `${handoff.askedBy === "person" ? "You took the screen" : `It needs ${CAUSE_WORDS[handoff.cause] ?? "you"}`}${handoff.note ? `: ${handoff.note}` : ""}. Open later.dog to see the screen.`.slice(0, 200),
  };
}

export interface RunView {
  run: ComputerUseRun;
  steps: LoggedStep[];
  handoffs: Handoff[];
  form: RunFormView | null;
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
  readonly phone: PhonePush | undefined;
  readonly #live = new Map<string, { computerId: string; desktop: UseDesktop; control: RunControl; forms: RunSecureForms; finished: Promise<ComputerUseRun> }>();

  constructor(store: ComputerUseStore, engine: ComputerUseEngine | { unavailable: string }, options: ComputerUseOptions = {}) {
    this.store = store;
    this.#engine = "unavailable" in engine ? null : engine;
    this.#unavailable = "unavailable" in engine ? engine.unavailable : "";
    this.phone = options.phone;
    store.interrupted();
  }

  readonly #notify = (notice: TakeoverNotice): void => {
    void this.phone?.send(takeoverNotification(notice)).catch(() => {});
  };

  readonly #notifyForm = (notice: FormNotice): void => {
    void this.phone?.send(formNotification(notice)).catch(() => {});
  };

  start(body: unknown): ComputerUseRun {
    const engine = this.#engine;
    if (!engine) throw unavailable(this.#unavailable);
    const input = startRunSchema.parse(body);
    if ([...this.#live.values()].some((live) => live.computerId === input.computerId)) {
      throw unavailable("Another computer-use run is going on that computer; stop it, or wait for it to end, before starting one there.");
    }
    const run = this.store.start({ ...input, model: engine.messages.model, screenChecks: Boolean(engine.screenChecks) });
    const control = new RunControl();
    const desktop = engine.desktop(run.computerId);
    const forms = new RunSecureForms();
    const finished = runComputerUse(run.id, {
      store: this.store, desktop, messages: engine.messages, control, pageCheck: engine.pageCheck, forms,
      clock: engine.clock ?? Date.now, sleep: engine.sleep ?? waitFor, limits: engine.limits ?? DEFAULT_LIMITS, notify: this.#notify, notifyForm: this.#notifyForm,
      ...(engine.screenChecks ? { screenChecks: engine.screenChecks } : {}),
    }).finally(() => { forms.end(); this.#live.delete(run.id); });
    finished.catch(() => {});
    this.#live.set(run.id, { computerId: run.computerId, desktop, control, forms, finished });
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

  async takeOver(id: string, body: unknown): Promise<{ run: ComputerUseRun; handoff: Handoff }> {
    const input = takeOverSchema.parse(body ?? {});
    const live = this.#live.get(id);
    if (!live) throw unavailable("This run is not going on this supervisor now, so there is no screen to take over.");
    const handoff = await handOverScreen(id, { cause: input.cause, askedBy: "person", note: input.note },
      { store: this.store, desktop: live.desktop, control: live.control, notify: this.#notify });
    return { run: this.store.run(id), handoff };
  }

  handBack(id: string, body: unknown = {}): ComputerUseRun {
    const input = handBackSchema.parse(body ?? {});
    const run = this.store.handBack(id);
    this.#live.get(id)?.control.release(input.approve);
    return run;
  }

  secureForm(id: string, body: unknown): { run: ComputerUseRun; form: RunFormView | null } {
    const input = secureFormSchema.parse(body);
    const live = this.#live.get(id);
    if (!live) throw unavailable("This run is not going on this supervisor now, so it has no Secure Form to fill in.");
    if ("cancel" in input) {
      if (!live.forms.cancel(input.formId)) throw unavailable("This Secure Form is not waiting for the person.");
      live.control.answerForm(input.formId, "cancelled");
    } else {
      const sent = live.forms.submit(input.formId, input.values);
      if (!sent.ok) throw Object.assign(new Error(sent.error), { status: sent.status });
      live.control.answerForm(input.formId, "filled");
    }
    return { run: this.store.run(id), form: live.forms.view(input.formId) };
  }

  view(id: string): RunView {
    return { run: this.store.run(id), steps: this.store.steps(id), handoffs: this.store.handoffs(id), form: this.#live.get(id)?.forms.waiting() ?? null };
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
const RUNS_PATH = /^\/v1\/computer-runs(?:\/([\w-]+)(?:\/(done|not-done|stop|take-over|hand-back|secure-form))?)?$/;
const PHONE_PATH = "/v1/computer-runs/phone-push";
const STEP_PATH = /^\/v1\/computer-runs\/([\w-]+)\/steps\/(\d{1,4})\/failure-class$/;
const failureClassSchema = z.object({ failureClass: z.enum(FAILURE_CLASSES).nullable() }).strict();

export async function computerUseRoute(runs: ComputerUseRuns | undefined, method: string, pathname: string, body: () => Promise<unknown>): Promise<RouteAnswer> {
  const stepMatch = STEP_PATH.exec(pathname);
  const match = RUNS_PATH.exec(pathname);
  if (!match && !stepMatch) return null;
  if (!runs) return { status: 409, body: { error: "Computer-use runs are not set up on this supervisor." } };
  if (stepMatch) {
    if (method !== "POST") return null;
    const input = failureClassSchema.parse(await body());
    return { status: 200, body: { step: runs.store.classify(runId.parse(stepMatch[1]), Number(stepMatch[2]), input.failureClass) } };
  }
  if (!match) return null;
  if (pathname === PHONE_PATH) {
    if (!runs.phone) return { status: 409, body: { error: "Phone notifications are not set up on this supervisor." } };
    return phonePushRequest(method, body, runs.phone);
  }
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
  if (verb === "take-over") return { status: 200, body: await runs.takeOver(id, await body()) };
  if (verb === "secure-form") return { status: 200, body: runs.secureForm(id, await body()) };
  return { status: 200, body: { run: runs.handBack(id, await body()) } };
}

export function screenChecksSwitch(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "" || value === "off") return false;
  if (value === "on") return true;
  throw new Error("LATERDOG_SCREEN_CHECKS is on or off.");
}

export function computerUseRunsFromEnvironment(db: DatabaseSync, env: NodeJS.ProcessEnv, options: ComputerUseOptions = {}): ComputerUseRuns {
  const store = new ComputerUseStore(db);
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return new ComputerUseRuns(store, { unavailable: "Claude computer use needs ANTHROPIC_API_KEY in the supervisor's environment." }, options);
  try {
    const computersKey = env.LATERDOG_COMPUTERS_KEY?.trim();
    if (computersKey && !/^ldc_[!-~]{8,1024}$/.test(computersKey)) throw new Error("LATERDOG_COMPUTERS_KEY does not hold a later.dog computers key (they start with ldc_)");
    const computers = new LaterdogComputers({ api: computersApi(env.LATERDOG_COMPUTERS_URL?.trim() || INTERNAL_COMPUTERS_API), ...(computersKey ? { key: computersKey } : {}) }, fetch);
    const messages = anthropicMessages(apiKey, { url: fixtureMessagesUrl(env.LATERDOG_ANTHROPIC_URL) });
    const screenChecks = screenChecksSwitch(env.LATERDOG_SCREEN_CHECKS) ? clefScreenChecks((body) => computers.screenCheck(body)) : undefined;
    return new ComputerUseRuns(store, { messages, desktop: (id) => new CloudDesktop(computers, id), pageCheck: livePageCheck(), ...(screenChecks ? { screenChecks } : {}) }, options);
  } catch (error) {
    return new ComputerUseRuns(store, { unavailable: error instanceof Error ? error.message : String(error) }, options);
  }
}
