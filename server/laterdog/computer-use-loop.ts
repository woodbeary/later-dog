import { createHash } from "node:crypto";
import {
  cursorFromXdotool, describeAction, onScreen, parseAction, TOOLSET_NAME, type ComputerAction,
} from "./computer-use-actions.ts";
import { TAKEOVER_TOOL_NAME, thinkingSummary, type ContentBlock, type MessagesApi, type MessageTurn } from "./computer-use-anthropic.ts";
import type { PageCheck, PageCheckResult, StateCheckRule } from "./computer-use-done.ts";
import { frameSize, toFrame, toScreen, withinToolsetLimits, type Point, type Size } from "./computer-use-frame.ts";
import { CONFIRM_LOOKS_MS, cropBox, guardedWords, isGuarded, type GuardedAction } from "./computer-use-guard.ts";
import { isPersonState, YES, type ScreenChecks, type ScreenRead, type ScreenState } from "./computer-use-screen.ts";
import { isOpenRun, type AskedBy, type ComputerUseRun, type ComputerUseStore, type Handoff, type HandoffCause, type StepOutcome, type ViewerLink } from "./computer-use-store.ts";
import { parseTakeoverInput } from "./takeover.ts";
import { fillSecureField, parseSecureFormInput } from "./secure-form.ts";
import { FILL_FIELD_TOOL_NAME, REQUEST_FORM_TOOL_NAME, type RunFormView, type RunSecureForms } from "./computer-use-secure-form.ts";

export type DesktopAction = Exclude<ComputerAction, { kind: "screenshot" | "wait" }>;

export interface UseDesktop {
  screen(signal: AbortSignal): Promise<Size>;
  screenshot(frame: Size, screen: Size, signal: AbortSignal): Promise<Buffer>;
  act(action: DesktopAction, signal: AbortSignal): Promise<string>;
  viewer?(signal: AbortSignal): Promise<ViewerLink>;
  crop?(box: { x: number; y: number; width: number; height: number }, signal: AbortSignal): Promise<Buffer>;
  run?(command: string, signal: AbortSignal): Promise<{ ok: boolean; exitCode: number | null; stdout: string }>;
  stateCheck?(rule: StateCheckRule, signal: AbortSignal): Promise<PageCheckResult>;
}

export interface TakeoverNotice {
  runId: string;
  task: string;
  handoff: Handoff;
}

export interface FormNotice {
  runId: string;
  task: string;
  form: RunFormView;
}

export interface LoopLimits {
  maxSteps: number;
  maxWorkingMs: number;
}

export const DEFAULT_LIMITS: LoopLimits = { maxSteps: 100, maxWorkingMs: 30 * 60_000 };

export interface LoopDeps {
  store: ComputerUseStore;
  desktop: UseDesktop;
  messages: MessagesApi;
  control: RunControl;
  pageCheck: PageCheck;
  clock: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  limits: LoopLimits;
  notify?: (notice: TakeoverNotice) => void;
  notifyForm?: (notice: FormNotice) => void;
  screenChecks?: ScreenChecks;
  forms?: RunSecureForms;
}

export const SYSTEM_PROMPT = [
  "You are using a Linux desktop (Xfce with Chromium) through the computer tools to do one task for the person. Each screenshot is the whole screen.",
  "To sign in, open the sign-in page, call request_secure_form for only what the person knows (an email or username, a password, a one-time code), then type each value with fill_secure_field. You never see the values.",
  "When a step needs the person on the screen (a sign-in or code a Secure Form cannot cover, a passkey, a CAPTCHA, a payment, or a final yes before anything is sent or bought), first open the exact page and fill in everything you can, then call request_takeover with that one step. Never ask for passwords or codes in your text.",
  "On a sign-in, verification-code or CAPTCHA screen, ask for the person before you act on it: later.dog checks each screenshot, and hands the screen to the person when you act on such a screen without asking.",
  "Before a click or Enter that submits, pays, publishes, cancels or deletes something, later.dog asks the person to approve it. When later.dog says it is unknown whether such an action went through, never repeat it: take a screenshot and look.",
  "When you believe the task is finished, stop calling tools and say in one short line what you did. You cannot mark the task done: the person, or a check of the live page, decides that.",
].join("\n");
export const NOT_EXECUTED = "Not executed: an earlier computer action in this turn failed.";
export const TAKEN_OVER = "Not executed: the person took over the screen. Take a fresh screenshot before you go on.";
export const AFTER_HANDBACK = "Not executed: the screen was handed to the person before this action. Take a fresh screenshot before you go on.";
export const HANDED_BACK_NOTE = "The person had the screen for a while and has handed it back. Take a fresh screenshot before you go on.";
export const SCREEN_TAKEN = "Not executed: the screen shows a sign-in, a verification code or a CAPTCHA, so later.dog handed it to the person. Take a fresh screenshot before you go on.";
const SCREEN_CAUSE: Partial<Record<ScreenState, HandoffCause>> = { login: "sign-in", two_factor: "sign-in", captcha: "captcha" };
export const NOT_APPROVED = "Not executed: the person did not approve this action, so later.dog did not run it. They may have done this step themselves. Take a fresh screenshot before you go on.";
export const SUBMISSION_UNKNOWN = "Unknown whether this went through: later.dog ran it but could not see a confirmation. Do not repeat it. Take a screenshot and look; only the person or a check of the page can settle it.";
export const UNKNOWN_PENDING = "Not executed: an earlier action's outcome is still unknown, so later.dog will not run another that submits, pays, publishes, cancels or deletes until the person or a check of the page settles it.";

export type FormOutcome = "filled" | "cancelled";

export class RunControl {
  readonly #abort = new AbortController();
  #held = false;
  #returned = false;
  #waiters: Array<() => void> = [];
  #screen: ScreenRead | null = null;
  #handled: ScreenState | null = null;
  #approved = false;
  #unknown = false;
  #form: { id: string; answer: (outcome: FormOutcome) => void } | null = null;

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  get held(): boolean {
    return this.#held;
  }

  hold(): void {
    this.#held = true;
  }

  release(approved = false): void {
    this.#held = false;
    this.#returned = true;
    this.#approved = approved;
    this.#wake();
  }

  takeApproval(): boolean {
    const approved = this.#approved;
    this.#approved = false;
    return approved;
  }

  waitForForm(formId: string): Promise<FormOutcome> {
    return new Promise<FormOutcome>((resolve, reject) => {
      const stop = () => { this.#form = null; reject(this.#abort.signal.reason); };
      if (this.#abort.signal.aborted) return stop();
      this.#abort.signal.addEventListener("abort", stop, { once: true });
      this.#form = { id: formId, answer: (outcome) => { this.#abort.signal.removeEventListener("abort", stop); this.#form = null; resolve(outcome); } };
    });
  }

  answerForm(formId: string, outcome: FormOutcome): boolean {
    if (this.#form?.id !== formId) return false;
    this.#form.answer(outcome);
    return true;
  }

  openUnknown(): void {
    this.#unknown = true;
  }

  get unknownOpen(): boolean {
    return this.#unknown;
  }

  end(): void {
    this.#abort.abort(new Error("The person ended this run."));
    this.#wake();
  }

  noteScreen(read: ScreenRead | null): void {
    this.#screen = read;
    if (!isPersonState(read)) this.#handled = null;
  }

  get screen(): ScreenRead | null {
    return this.#screen;
  }

  screenNeedsPerson(): ScreenRead | null {
    const read = this.#screen;
    return isPersonState(read) && read.screen !== this.#handled ? read : null;
  }

  markHandled(): void {
    if (isPersonState(this.#screen)) this.#handled = this.#screen.screen;
  }

  takeReturn(): boolean {
    const returned = this.#returned;
    this.#returned = false;
    return returned;
  }

  async ready(): Promise<void> {
    while (this.#held && !this.#abort.signal.aborted) await new Promise<void>((resolve) => this.#waiters.push(resolve));
    this.#abort.signal.throwIfAborted();
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }
}

async function viewerLink(desktop: UseDesktop, signal: AbortSignal): Promise<ViewerLink | null> {
  if (!desktop.viewer) return null;
  try { return await desktop.viewer(signal); } catch { return null; }
}

export async function handOverScreen(runId: string, ask: { cause: HandoffCause; askedBy: AskedBy; note: string; probability?: number },
  deps: Pick<LoopDeps, "store" | "desktop" | "control" | "notify">): Promise<Handoff> {
  const run = deps.store.handOver(runId, ask.cause, ask.askedBy, ask.note, ask.probability ?? null);
  deps.control.hold();
  deps.control.markHandled();
  let handoff = deps.store.openHandoff(runId)!;
  const link = await viewerLink(deps.desktop, deps.control.signal);
  if (link) handoff = deps.store.attachViewer(runId, handoff.number, link) ?? handoff;
  try { deps.notify?.({ runId, task: run.task, handoff }); } catch {}
  return handoff;
}

export function sameModel(pinned: string, answered: string): boolean {
  return answered === pinned || (answered.startsWith(`${pinned}-`) && /^\d{8}$/.test(answered.slice(pinned.length + 1)));
}

export function screenshotSha256(frame: Buffer): string {
  return createHash("sha256").update(frame).digest("hex");
}

const text = (value: string): ContentBlock => ({ type: "text", text: value });
const image = (frame: Buffer): ContentBlock => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.toString("base64") } });
const plain = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 500) || "Unknown error.";

type ToolUse = { id: string; name: string; input: unknown; toolset: boolean };

function toolUses(content: ContentBlock[]): ToolUse[] {
  return content.flatMap((block) => block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string"
    ? [{ id: block.id, name: block.name, input: block.input, toolset: block.toolset_name === TOOLSET_NAME }]
    : []);
}

function replyText(content: ContentBlock[]): string {
  return content.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join(" ").replace(/\s+/g, " ").trim().slice(0, 500);
}

interface Turn {
  runId: string;
  step: number;
  frame: Size;
  screen: Size;
  latest: Buffer;
  changes: { pending: { step: number; from: string } | null };
  deps: LoopDeps;
}

interface Acted {
  results: ContentBlock[];
  actions: Record<string, unknown>[];
  shot: Buffer | null;
  heldMs: number;
  outcome: StepOutcome | null;
  unchanged: boolean | null;
}

function loggedAction(use: ToolUse): Record<string, unknown> {
  if (use.name === REQUEST_FORM_TOOL_NAME) return { name: use.name };
  if (use.name === FILL_FIELD_TOOL_NAME) return { name: use.name };
  return describeAction(use.name, use.input);
}

const record = (input: unknown): Record<string, unknown> => (input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {});

async function askForm(use: ToolUse, turn: Turn, acted: Acted, logged: Record<string, unknown>): Promise<{ text: string; ok: boolean }> {
  const { deps } = turn;
  const forms = deps.forms!;
  const input = parseSecureFormInput(record(use.input));
  if ("error" in input) { logged.outcome = "refused"; return { text: input.error, ok: false }; }
  const { formId } = forms.open(input);
  logged.fields = input.fields.length;
  deps.control.markHandled();
  try { deps.notifyForm?.({ runId: turn.runId, task: deps.store.run(turn.runId).task, form: forms.view(formId)! }); } catch {}
  const from = deps.clock();
  const outcome = await deps.control.waitForForm(formId);
  acted.heldMs += deps.clock() - from;
  logged.outcome = outcome;
  if (outcome === "cancelled") return { text: "The person closed the Secure Form without filling it in. If the step still needs them, call request_takeover.", ok: true };
  const ids = input.fields.map((field) => `${field.id} (${field.label})`).join(", ");
  return { ok: true, text: `The person filled in ${JSON.stringify(input.title)} for ${input.host} (form_id ${JSON.stringify(formId)}). Take a screenshot, then call fill_secure_field for each field: ${ids}. You never see the values. Set submit to true on the last field, then take a screenshot to check the result.` };
}

async function fillField(use: ToolUse, turn: Turn, logged: Record<string, unknown>): Promise<{ text: string; ok: boolean }> {
  const { deps, frame, screen } = turn;
  const args = record(use.input);
  const x = args.x;
  const y = args.y;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > frame.width || y > frame.height) {
    logged.outcome = "not typed";
    return { ok: false, text: `x and y must be whole pixel positions inside the ${frame.width}x${frame.height} screenshot.` };
  }
  const run = deps.desktop.run;
  if (!run) { logged.outcome = "not typed"; return { ok: false, text: "This desktop cannot type Secure Form values." }; }
  const [sx, sy] = toScreen([x, y], frame, screen);
  const filled = await fillSecureField({ ...args, x: sx, y: sy }, deps.forms!, (command) => run.call(deps.desktop, command, deps.control.signal));
  deps.control.signal.throwIfAborted();
  logged.outcome = filled.ok ? "typed" : "not typed";
  return filled;
}

const nothingActed = (): Acted => ({ results: [], actions: [], shot: null, heldMs: 0, outcome: null, unchanged: null });

function markActed(turn: Turn): void {
  turn.changes.pending ??= { step: turn.step, from: screenshotSha256(turn.latest) };
}

function markLooked(turn: Turn, shot: Buffer, done: Acted): void {
  const pending = turn.changes.pending;
  if (!pending) return;
  turn.changes.pending = null;
  const unchanged = screenshotSha256(shot) === pending.from;
  if (pending.step === turn.step) done.unchanged = (done.unchanged ?? false) || unchanged;
  else turn.deps.store.screenAfter(turn.runId, pending.step, unchanged);
}

async function pointer(turn: Turn, action: GuardedAction): Promise<Point | null> {
  if (action.kind !== "click") return null;
  if (action.at) return toScreen(action.at, turn.frame, turn.screen);
  try { return cursorFromXdotool(await turn.deps.desktop.act({ kind: "cursor_position" }, turn.deps.control.signal)); } catch { return null; }
}

async function irreversible(action: GuardedAction, words: string, turn: Turn): Promise<number | null> {
  const { desktop, control, screenChecks } = turn.deps;
  let picture = turn.latest;
  const at = desktop.crop ? await pointer(turn, action) : null;
  if (at && desktop.crop) {
    try { picture = await desktop.crop(cropBox(at, turn.screen), control.signal); } catch (error) { if (control.signal.aborted) throw error; }
  }
  return screenChecks!.irreversible(picture, words, control.signal);
}

async function wentThrough(action: GuardedAction, words: string, turn: Turn): Promise<boolean> {
  const { desktop, control, screenChecks, sleep } = turn.deps;
  try { await desktop.act(onScreen(action, turn.frame, turn.screen) as DesktopAction, control.signal); }
  catch (error) { if (control.signal.aborted) throw error; return false; }
  for (const ms of CONFIRM_LOOKS_MS) {
    await sleep(ms, control.signal);
    let after: Buffer;
    try { after = await desktop.screenshot(turn.frame, turn.screen, control.signal); } catch (error) { if (control.signal.aborted) throw error; continue; }
    const confirmed = await screenChecks!.confirmed(after, words, control.signal);
    if (confirmed !== null && confirmed >= YES) return true;
  }
  return false;
}

const ACTING: ReadonlySet<ComputerAction["kind"]> = new Set(["click", "drag", "mouse_down", "mouse_up", "scroll", "type", "key", "hold_key"]);

async function observe(frame: Buffer, deps: LoopDeps): Promise<void> {
  if (!deps.screenChecks) return;
  deps.control.noteScreen(await deps.screenChecks.state(frame, deps.control.signal));
}

async function act(uses: ToolUse[], turn: Turn, done: Acted): Promise<void> {
  const { deps, frame, screen } = turn;
  const { control, desktop } = deps;
  const signal = control.signal;
  let failed = false;
  let blocked: string | null = null;
  for (const use of uses) {
    signal.throwIfAborted();
    const logged = loggedAction(use);
    done.actions.push(logged);
    const answer = (content: ContentBlock[], isError = false) => done.results.push({
      type: "tool_result", tool_use_id: use.id, ...(use.toolset ? { toolset_name: TOOLSET_NAME } : {}), content, ...(isError ? { is_error: true } : {}),
    });
    if (blocked) { answer([text(blocked)], true); continue; }
    if (failed) { answer([text(NOT_EXECUTED)], true); continue; }
    if (control.held) { blocked = TAKEN_OVER; answer([text(blocked)], true); continue; }
    if (!use.toolset && deps.forms && (use.name === REQUEST_FORM_TOOL_NAME || use.name === FILL_FIELD_TOOL_NAME)) {
      const answered = use.name === REQUEST_FORM_TOOL_NAME ? await askForm(use, turn, done, logged) : await fillField(use, turn, logged);
      if (!answered.ok) failed = true;
      else if (use.name === FILL_FIELD_TOOL_NAME) markActed(turn);
      answer([text(answered.text)], !answered.ok);
      continue;
    }
    if (!use.toolset) {
      const asked = use.name === TAKEOVER_TOOL_NAME && use.input && typeof use.input === "object" ? parseTakeoverInput(use.input as Record<string, unknown>) : null;
      if (!asked) { failed = true; answer([text(use.name === TAKEOVER_TOOL_NAME ? "request_takeover needs a step." : `${use.name} is not a tool in this run.`)], true); continue; }
      const from = deps.clock();
      await handOverScreen(turn.runId, { cause: asked.reason, askedBy: "model", note: asked.step }, deps);
      await control.ready();
      done.heldMs += deps.clock() - from;
      control.takeReturn();
      answer([text(`The person handed the screen back after ${JSON.stringify(asked.step)}. Take a fresh screenshot to see where things stand, then carry on.`)]);
      blocked = AFTER_HANDBACK;
      continue;
    }
    const parsed = parseAction(use.name, use.input, frame);
    if ("problem" in parsed) { failed = true; answer([text(parsed.problem)], true); continue; }
    const person = ACTING.has(parsed.action.kind) ? control.screenNeedsPerson() : null;
    if (person) {
      await handOverScreen(turn.runId, { cause: SCREEN_CAUSE[person.screen] ?? "other", askedBy: "screen_check", probability: person.probability,
        note: `The screen check saw ${person.screen.replace("_", " ")} (${person.probability}) and Claude went on without asking for the person.` }, deps);
      blocked = TAKEN_OVER;
      answer([text(SCREEN_TAKEN)], true);
      continue;
    }
    if (deps.screenChecks && isGuarded(parsed.action)) {
      const action = parsed.action;
      if (control.unknownOpen) { failed = true; answer([text(UNKNOWN_PENDING)], true); continue; }
      const words = guardedWords(use.name, use.input);
      const yes = await irreversible(action, words, turn);
      if (yes === null || yes >= YES) {
        const from = deps.clock();
        await handOverScreen(turn.runId, { cause: "confirm", askedBy: "guard", ...(yes === null ? {} : { probability: yes }),
          note: yes === null ? `Claude wants to ${words}; the guard could not check it, so the person decides.` : `Claude wants to ${words}; it looks like it submits, pays, publishes, cancels or deletes something.` }, deps);
        await control.ready();
        done.heldMs += deps.clock() - from;
        control.takeReturn();
        if (!control.takeApproval()) { blocked = AFTER_HANDBACK; answer([text(NOT_APPROVED)], true); continue; }
        if (await wentThrough(action, words, turn)) { markActed(turn); answer([text("OK")]); continue; }
        done.outcome = "submission_unknown";
        control.openUnknown();
        failed = true;
        answer([text(SUBMISSION_UNKNOWN)], true);
        continue;
      }
    }
    try {
      const action = parsed.action;
      if (action.kind === "screenshot") {
        const shot = await desktop.screenshot(frame, screen, signal);
        done.shot = shot;
        markLooked(turn, shot, done);
        turn.latest = shot;
        await observe(shot, deps);
        answer([image(shot)]);
      } else if (action.kind === "wait") {
        await deps.sleep(action.seconds * 1000, signal);
        answer([text("OK")]);
      } else {
        const output = await desktop.act(onScreen(action, frame, screen) as DesktopAction, signal);
        if (ACTING.has(action.kind)) markActed(turn);
        if (action.kind !== "cursor_position") answer([text("OK")]);
        else {
          const at = cursorFromXdotool(output);
          if (!at) throw new Error("The desktop did not report where the pointer is.");
          const [x, y] = toFrame(at, frame, screen);
          answer([text(`X=${x}, Y=${y}`)]);
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      failed = true;
      answer([text(`Error: ${plain(error)}`)], true);
    }
  }
}

const SETTLED_UNKNOWN = " That settled a submit whose outcome was unknown.";

type Checked = { passed: true; source: "page_check" | "state_check"; detail: string } | { passed: false; missed: string[] };

async function doneChecks(run: ComputerUseRun, deps: LoopDeps): Promise<Checked> {
  const missed: string[] = [];
  if (run.done.pageCheck) {
    const check = await deps.pageCheck(run.done.pageCheck, deps.control.signal);
    if (check.passed) return { passed: true, source: "page_check", detail: check.detail };
    missed.push(`The page check did not pass: ${check.detail}`);
  }
  if (run.done.stateCheck) {
    let check: PageCheckResult = { passed: false, detail: "This desktop cannot run a state check." };
    if (deps.desktop.stateCheck) {
      try { check = await deps.desktop.stateCheck(run.done.stateCheck, deps.control.signal); }
      catch (error) { if (deps.control.signal.aborted) throw error; check = { passed: false, detail: "The state check could not reach the desktop." }; }
    }
    if (check.passed) return { passed: true, source: "state_check", detail: check.detail };
    missed.push(`The state check did not pass: ${check.detail}`);
  }
  return { passed: false, missed };
}

async function settle(run: ComputerUseRun, said: string, deps: LoopDeps): Promise<ComputerUseRun> {
  const unknown = deps.control.unknownOpen;
  const claim = `${said ? `Claude says it is finished: ${said}` : "Claude says it is finished."}${unknown ? " Whether a submit went through is unknown." : ""}`;
  const checked = await doneChecks(run, deps);
  if (checked.passed) return deps.store.finish(run.id, { done: checked.source, detail: `${checked.detail}${unknown ? SETTLED_UNKNOWN : ""}` });
  return deps.store.awaitPerson(run.id, [claim, ...checked.missed].join(" "), unknown);
}

async function settleUnknown(run: ComputerUseRun, deps: LoopDeps): Promise<ComputerUseRun | null> {
  const checked = await doneChecks(run, deps);
  return checked.passed ? deps.store.finish(run.id, { done: checked.source, detail: `${checked.detail}${SETTLED_UNKNOWN}` }) : null;
}

export async function runComputerUse(runId: string, deps: LoopDeps): Promise<ComputerUseRun> {
  const { store, control } = deps;
  try {
    const run = store.run(runId);
    if (run.model !== deps.messages.model) throw new Error(`This run is pinned to ${run.model}, but the loop calls ${deps.messages.model}.`);
    const screen = await deps.desktop.screen(control.signal);
    const frame = frameSize(screen);
    if (!withinToolsetLimits(frame)) throw new Error(`A ${frame.width}x${frame.height} screenshot is over the computer tool's image limits.`);
    const first = await deps.desktop.screenshot(frame, screen, control.signal);
    await observe(first, deps);
    const messages: MessageTurn[] = [{ role: "user", content: [text(`Task: ${run.task}`), image(first)] }];
    let seen = screenshotSha256(first);
    let seenRead = control.screen;
    let latest = first;
    const changes: Turn["changes"] = { pending: null };
    let workingMs = 0;
    for (let step = 1; ; step++) {
      await control.ready();
      if (control.takeReturn()) messages.at(-1)!.content.push(text(HANDED_BACK_NOTE));
      if (step > deps.limits.maxSteps) return store.finish(runId, { failed: "step_limit", detail: `Stopped after ${deps.limits.maxSteps} steps.` });
      if (workingMs > deps.limits.maxWorkingMs) return store.finish(runId, { failed: "timed_out", detail: `Stopped after ${Math.round(deps.limits.maxWorkingMs / 60_000)} minutes of work.` });
      const asked = deps.clock();
      const reply = await deps.messages.create({ system: SYSTEM_PROMPT, messages }, control.signal);
      const modelMs = deps.clock() - asked;
      const started = deps.clock();
      const acted = nothingActed();
      const uses = reply.stopReason === "tool_use" ? toolUses(reply.content) : [];
      let actionMs = 0;
      try {
        control.signal.throwIfAborted();
        if (!sameModel(run.model, reply.model)) throw new Error(`Claude's API answered with ${reply.model}, not the pinned ${run.model}.`);
        messages.push({ role: "assistant", content: reply.content });
        if (uses.length) await act(uses, { runId, step, frame, screen, latest, changes, deps }, acted);
      } finally {
        actionMs = Math.max(0, deps.clock() - started - acted.heldMs);
        store.step(runId, { step, actions: acted.actions, screenshotSha256: seen, modelMs, actionMs, ...reply.usage,
          screenState: seenRead?.screen ?? null, screenProbability: seenRead?.probability ?? null, outcome: acted.outcome,
          thinking: thinkingSummary(reply.content), screenUnchanged: acted.unchanged });
      }
      workingMs += modelMs + actionMs;
      if (acted.shot) { seen = screenshotSha256(acted.shot); seenRead = control.screen; latest = acted.shot; }
      if (acted.outcome === "submission_unknown") {
        const settled = await settleUnknown(run, deps);
        if (settled) return settled;
      }
      if (reply.stopReason === "refusal") return store.finish(runId, { failed: "refusal", detail: "Claude declined this task." });
      if (reply.stopReason === "end_turn") return await settle(run, replyText(reply.content), deps);
      if (reply.stopReason !== "tool_use" || !uses.length) throw new Error(`Claude's turn stopped with ${reply.stopReason ?? "no reason"}.`);
      messages.push({ role: "user", content: acted.results });
    }
  } catch (error) {
    const current = store.run(runId);
    if (control.signal.aborted || !isOpenRun(current.state)) return current;
    return store.finish(runId, { failed: "error", detail: plain(error) });
  }
}
