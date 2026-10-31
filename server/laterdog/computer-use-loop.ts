import { createHash } from "node:crypto";
import {
  cursorFromXdotool, describeAction, onScreen, parseAction, TOOLSET_NAME, type ComputerAction,
} from "./computer-use-actions.ts";
import { TAKEOVER_TOOL_NAME, type ContentBlock, type MessagesApi, type MessageTurn } from "./computer-use-anthropic.ts";
import type { PageCheck } from "./computer-use-done.ts";
import { frameSize, toFrame, withinToolsetLimits, type Size } from "./computer-use-frame.ts";
import { isOpenRun, type ComputerUseRun, type ComputerUseStore } from "./computer-use-store.ts";
import { parseTakeoverInput } from "./takeover.ts";

export type DesktopAction = Exclude<ComputerAction, { kind: "screenshot" | "wait" }>;

export interface UseDesktop {
  screen(signal: AbortSignal): Promise<Size>;
  screenshot(frame: Size, screen: Size, signal: AbortSignal): Promise<Buffer>;
  act(action: DesktopAction, signal: AbortSignal): Promise<string>;
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
}

export const SYSTEM_PROMPT = [
  "You are using a Linux desktop (Xfce with Chromium) through the computer tools to do one task for the person. Each screenshot is the whole screen.",
  "When a step needs the person on the screen (a sign-in or code you were not given, a passkey, a CAPTCHA, a payment, or a final yes before anything is sent or bought), first open the exact page and fill in everything you can, then call request_takeover with that one step. Never ask for passwords or codes in your text.",
  "When you believe the task is finished, stop calling tools and say in one short line what you did. You cannot mark the task done: the person, or a check of the live page, decides that.",
].join("\n");
export const NOT_EXECUTED = "Not executed: an earlier computer action in this turn failed.";
export const TAKEN_OVER = "Not executed: the person took over the screen. Take a fresh screenshot before you go on.";
export const AFTER_HANDBACK = "Not executed: the screen was handed to the person before this action. Take a fresh screenshot before you go on.";
export const HANDED_BACK_NOTE = "The person had the screen for a while and has handed it back. Take a fresh screenshot before you go on.";

export class RunControl {
  readonly #abort = new AbortController();
  #held = false;
  #returned = false;
  #waiters: Array<() => void> = [];

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  get held(): boolean {
    return this.#held;
  }

  hold(): void {
    this.#held = true;
  }

  release(): void {
    this.#held = false;
    this.#returned = true;
    this.#wake();
  }

  end(): void {
    this.#abort.abort(new Error("The person ended this run."));
    this.#wake();
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
  deps: LoopDeps;
}

interface Acted {
  results: ContentBlock[];
  actions: Record<string, unknown>[];
  shot: Buffer | null;
  heldMs: number;
}

const nothingActed = (): Acted => ({ results: [], actions: [], shot: null, heldMs: 0 });

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
      deps.store.handOver(turn.runId, asked.reason, "model", asked.step);
      control.hold();
      const from = deps.clock();
      await control.ready();
      acted.heldMs += deps.clock() - from;
      control.takeReturn();
      answer([text(`The person handed the screen back after ${JSON.stringify(asked.step)}. Take a fresh screenshot to see where things stand, then carry on.`)]);
      blocked = AFTER_HANDBACK;
      continue;
    }
    const parsed = parseAction(use.name, use.input, frame);
    if ("problem" in parsed) { failed = true; answer([text(parsed.problem)], true); continue; }
    try {
      const action = parsed.action;
      if (action.kind === "screenshot") {
        acted.shot = await desktop.screenshot(frame, screen, signal);
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
  const claim = said ? `Claude says it is finished: ${said}` : "Claude says it is finished.";
  if (!rule) return deps.store.awaitPerson(run.id, claim);
  const check = await deps.pageCheck(rule, deps.control.signal);
  if (check.passed) return deps.store.finish(run.id, { done: "page_check", detail: check.detail });
  return deps.store.awaitPerson(run.id, `${claim} The page check did not pass: ${check.detail}`);
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
    const messages: MessageTurn[] = [{ role: "user", content: [text(`Task: ${run.task}`), image(first)] }];
    let seen = screenshotSha256(first);
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
        if (uses.length) await act(uses, { runId, frame, screen, deps }, acted);
      } finally {
        actionMs = Math.max(0, deps.clock() - started - acted.heldMs);
        store.step(runId, { step, actions: acted.actions, screenshotSha256: seen, modelMs, actionMs, ...reply.usage });
      }
      workingMs += modelMs + actionMs;
      if (acted.shot) seen = screenshotSha256(acted.shot);
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
