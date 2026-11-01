import { createHash } from "node:crypto";
import {
  cursorFromXdotool, describeAction, onScreen, parseAction, TOOLSET_NAME, type ComputerAction,
} from "./computer-use-actions.ts";
import { TAKEOVER_TOOL_NAME, type ContentBlock, type MessagesApi, type MessageTurn } from "./computer-use-anthropic.ts";
import type { PageCheck } from "./computer-use-done.ts";
import { frameSize, toFrame, toScreen, withinToolsetLimits, type Point, type Size } from "./computer-use-frame.ts";
import { CONFIRM_LOOKS_MS, cropBox, guardedWords, isGuarded, type GuardedAction } from "./computer-use-guard.ts";
import { isPersonState, YES, type ScreenChecks, type ScreenRead, type ScreenState } from "./computer-use-screen.ts";
import { isOpenRun, type AskedBy, type ComputerUseRun, type ComputerUseStore, type Handoff, type HandoffCause, type StepOutcome, type ViewerLink } from "./computer-use-store.ts";
import { parseTakeoverInput } from "./takeover.ts";

export type DesktopAction = Exclude<ComputerAction, { kind: "screenshot" | "wait" }>;

export interface UseDesktop {
  screen(signal: AbortSignal): Promise<Size>;
  screenshot(frame: Size, screen: Size, signal: AbortSignal): Promise<Buffer>;
  act(action: DesktopAction, signal: AbortSignal): Promise<string>;
  viewer?(signal: AbortSignal): Promise<ViewerLink>;
  crop?(box: { x: number; y: number; width: number; height: number }, signal: AbortSignal): Promise<Buffer>;
}

export interface TakeoverNotice {
  runId: string;
  task: string;
  handoff: Handoff;
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
  screenChecks?: ScreenChecks;
}

export const SYSTEM_PROMPT = [
  "You are using a Linux desktop (Xfce with Chromium) through the computer tools to do one task for the person. Each screenshot is the whole screen.",
  "When a step needs the person on the screen (a sign-in or code you were not given, a passkey, a CAPTCHA, a payment, or a final yes before anything is sent or bought), first open the exact page and fill in everything you can, then call request_takeover with that one step. Never ask for passwords or codes in your text.",
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

export class RunControl {
  readonly #abort = new AbortController();
  #held = false;
  #returned = false;
  #waiters: Array<() => void> = [];
  #screen: ScreenRead | null = null;
  #handled: ScreenState | null = null;
  #approved = false;
  #unknown = false;

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
  frame: Size;
  screen: Size;
  latest: Buffer;
  deps: LoopDeps;
}

interface Acted {
  results: ContentBlock[];
  actions: Record<string, unknown>[];
  shot: Buffer | null;
  heldMs: number;
  outcome: StepOutcome | null;
}

const nothingActed = (): Acted => ({ results: [], actions: [], shot: null, heldMs: 0, outcome: null });

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

async function act(uses: ToolUse[], turn: Turn, acted: Acted): Promise<void> {
  const { deps, frame, screen } = turn;
  const { control, desktop } = deps;
  const signal = control.signal;
  let failed = false;
  let blocked: string | null = null;
  for (const use of uses) {
    signal.throwIfAborted();
    acted.actions.push(describeAction(use.name, use.input));
    const answer = (content: ContentBlock[], isError = false) => acted.results.push({
      type: "tool_result", tool_use_id: use.id, ...(use.toolset ? { toolset_name: TOOLSET_NAME } : {}), content, ...(isError ? { is_error: true } : {}),
    });
    if (blocked) { answer([text(blocked)], true); continue; }
    if (failed) { answer([text(NOT_EXECUTED)], true); continue; }
    if (control.held) { blocked = TAKEN_OVER; answer([text(blocked)], true); continue; }
    if (!use.toolset) {
      const asked = use.name === TAKEOVER_TOOL_NAME && use.input && typeof use.input === "object" ? parseTakeoverInput(use.input as Record<string, unknown>) : null;
      if (!asked) { failed = true; answer([text(use.name === TAKEOVER_TOOL_NAME ? "request_takeover needs a step." : `${use.name} is not a tool in this run.`)], true); continue; }
      const from = deps.clock();
      await handOverScreen(turn.runId, { cause: asked.reason, askedBy: "model", note: asked.step }, deps);
      await control.ready();
      acted.heldMs += deps.clock() - from;
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
        acted.heldMs += deps.clock() - from;
        control.takeReturn();
        if (!control.takeApproval()) { blocked = AFTER_HANDBACK; answer([text(NOT_APPROVED)], true); continue; }
        if (await wentThrough(action, words, turn)) { answer([text("OK")]); continue; }
        acted.outcome = "submission_unknown";
        control.openUnknown();
        failed = true;
        answer([text(SUBMISSION_UNKNOWN)], true);
        continue;
      }
    }
    try {
      const action = parsed.action;
      if (action.kind === "screenshot") {
        acted.shot = await desktop.screenshot(frame, screen, signal);
        turn.latest = acted.shot;
        await observe(acted.shot, deps);
        answer([image(acted.shot)]);
      } else if (action.kind === "wait") {
        await deps.sleep(action.seconds * 1000, signal);
        answer([text("OK")]);
      } else {
        const output = await desktop.act(onScreen(action, frame, screen) as DesktopAction, signal);
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

async function settle(run: ComputerUseRun, said: string, deps: LoopDeps): Promise<ComputerUseRun> {
  const rule = run.done.pageCheck;
  const unknown = deps.control.unknownOpen;
  const claim = `${said ? `Claude says it is finished: ${said}` : "Claude says it is finished."}${unknown ? " Whether a submit went through is unknown." : ""}`;
  if (!rule) return deps.store.awaitPerson(run.id, claim, unknown);
  const check = await deps.pageCheck(rule, deps.control.signal);
  if (check.passed) return deps.store.finish(run.id, { done: "page_check", detail: check.detail });
  return deps.store.awaitPerson(run.id, `${claim} The page check did not pass: ${check.detail}`, unknown);
}

async function settleUnknown(run: ComputerUseRun, deps: LoopDeps): Promise<ComputerUseRun | null> {
  const rule = run.done.pageCheck;
  if (!rule) return null;
  const check = await deps.pageCheck(rule, deps.control.signal);
  return check.passed ? deps.store.finish(run.id, { done: "page_check", detail: `${check.detail} That settled a submit whose outcome was unknown.` }) : null;
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
        if (uses.length) await act(uses, { runId, frame, screen, latest, deps }, acted);
      } finally {
        actionMs = Math.max(0, deps.clock() - started - acted.heldMs);
        store.step(runId, { step, actions: acted.actions, screenshotSha256: seen, modelMs, actionMs, ...reply.usage,
          screenState: seenRead?.screen ?? null, screenProbability: seenRead?.probability ?? null, outcome: acted.outcome });
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
