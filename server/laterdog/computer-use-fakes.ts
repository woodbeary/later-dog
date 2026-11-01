import { DatabaseSync } from "node:sqlite";
import { COMPUTER_USE_MODEL, type ContentBlock, type MessagesApi, type MessagesReply, type MessagesRequest, type TokenUsage } from "./computer-use-anthropic.ts";
import type { PageCheck, PageCheckResult } from "./computer-use-done.ts";
import type { Size } from "./computer-use-frame.ts";
import { RunControl, type DesktopAction, type UseDesktop } from "./computer-use-loop.ts";
import { ComputerUseStore, type ViewerLink } from "./computer-use-store.ts";
import type { ScreenChecks, ScreenRead } from "./computer-use-screen.ts";

export const FIXTURE_USAGE: TokenUsage = { inputTokens: 1_400, outputTokens: 90, cacheReadTokens: 1_200, cacheWriteTokens: 0 };
export const MODEL_MS = 800;
export const ACTION_MS = 40;

export class FakeClock {
  now = 0;
  readonly read = () => this.now;
  advance(ms: number): void {
    this.now += ms;
  }
}

export const FIXTURE_VIEWER: ViewerLink = { url: "https://cloud.later.dog/desktop/cmp_fixture12345/fixture-viewer-token/", expiresAt: "2026-11-01T12:00:00.000Z" };

export class FakeDesktop implements UseDesktop {
  readonly acted: DesktopAction[] = [];
  readonly frames: Size[] = [];
  viewers = 0;
  viewerFails = false;
  readonly crops: Array<{ x: number; y: number; width: number; height: number }> = [];
  readonly #size: Size;
  readonly #clock: FakeClock;
  readonly #fail: (action: DesktopAction) => string | null;

  constructor(options: { size?: Size; clock?: FakeClock; fail?: (action: DesktopAction) => string | null } = {}) {
    this.#size = options.size ?? { width: 1280, height: 800 };
    this.#clock = options.clock ?? new FakeClock();
    this.#fail = options.fail ?? (() => null);
  }

  async screen(): Promise<Size> {
    return this.#size;
  }

  async screenshot(frame: Size): Promise<Buffer> {
    this.frames.push(frame);
    this.#clock.advance(ACTION_MS);
    return Buffer.from(`fixture frame ${this.frames.length} at ${frame.width}x${frame.height}`);
  }

  async viewer(): Promise<ViewerLink> {
    this.viewers += 1;
    if (this.viewerFails) throw new Error("The computers service could not be reached.");
    return FIXTURE_VIEWER;
  }

  async crop(box: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
    this.crops.push(box);
    return Buffer.from(`crop ${box.x},${box.y} ${box.width}x${box.height}`);
  }

  async act(action: DesktopAction): Promise<string> {
    this.acted.push(action);
    this.#clock.advance(ACTION_MS);
    const problem = this.#fail(action);
    if (problem) throw new Error(problem);
    return action.kind === "cursor_position" ? "X=1280\nY=800\nSCREEN=0\nWINDOW=4194307\n" : "";
  }
}

export type ScriptedReply = MessagesReply | ((request: MessagesRequest) => MessagesReply | Promise<MessagesReply>);

export class ScriptedMessages implements MessagesApi {
  readonly model: string;
  readonly requests: MessagesRequest[] = [];
  readonly #replies: ScriptedReply[];
  readonly #clock: FakeClock;

  constructor(replies: ScriptedReply[], options: { clock?: FakeClock; model?: string } = {}) {
    this.#replies = [...replies];
    this.#clock = options.clock ?? new FakeClock();
    this.model = options.model ?? COMPUTER_USE_MODEL;
  }

  async create(request: MessagesRequest, signal: AbortSignal): Promise<MessagesReply> {
    signal.throwIfAborted();
    this.requests.push(structuredClone(request));
    const next = this.#replies.shift();
    if (!next) throw new Error("The fixture has no reply left for this request.");
    this.#clock.advance(MODEL_MS);
    return typeof next === "function" ? next(request) : next;
  }
}

export function toolUse(id: string, name: string, input: Record<string, unknown> = {}): ContentBlock {
  return { type: "tool_use", id, name, input, toolset_name: "computer" };
}

export function takeoverUse(id: string, step: string, reason: string): ContentBlock {
  return { type: "tool_use", id, name: "request_takeover", input: { step, reason } };
}

export function reply(content: ContentBlock[], stopReason = "tool_use", options: { usage?: TokenUsage; model?: string } = {}): MessagesReply {
  return { model: options.model ?? COMPUTER_USE_MODEL, stopReason, content, usage: options.usage ?? FIXTURE_USAGE };
}

export function finished(said: string): MessagesReply {
  return reply([{ type: "text", text: said }], "end_turn");
}

export function fixedPageCheck(result: PageCheckResult): PageCheck & { calls: number } {
  const check = Object.assign(async () => { check.calls += 1; return result; }, { calls: 0 });
  return check;
}

export function memoryStore(): ComputerUseStore {
  return new ComputerUseStore(new DatabaseSync(":memory:"));
}

export class WatchedControl extends RunControl {
  #onWait: Array<() => void> = [];

  waitingForPerson(): Promise<void> {
    return new Promise((resolve) => this.#onWait.push(resolve));
  }

  override async ready(): Promise<void> {
    if (this.held) {
      const waiting = this.#onWait;
      this.#onWait = [];
      for (const resolve of waiting) resolve();
    }
    return super.ready();
  }
}

export class ScriptedScreenChecks implements ScreenChecks {
  readonly looked: string[] = [];
  readonly asked: Array<{ question: "irreversible" | "confirmed"; action: string }> = [];
  readonly #states: (frame: string) => ScreenRead | null;
  readonly #irreversible: (action: string) => number | null;
  readonly #confirmed: (action: string) => number | null;

  constructor(options: { states?: (frame: string) => ScreenRead | null; irreversible?: (action: string) => number | null; confirmed?: (action: string) => number | null } = {}) {
    this.#states = options.states ?? (() => ({ screen: "ready", probability: 0.97 }));
    this.#irreversible = options.irreversible ?? (() => 0.02);
    this.#confirmed = options.confirmed ?? (() => 0.95);
  }

  async state(frame: Buffer): Promise<ScreenRead | null> {
    this.looked.push(frame.toString());
    return this.#states(frame.toString());
  }

  async irreversible(_crop: Buffer, action: string): Promise<number | null> {
    this.asked.push({ question: "irreversible", action });
    return this.#irreversible(action);
  }

  async confirmed(_frame: Buffer, action: string): Promise<number | null> {
    this.asked.push({ question: "confirmed", action });
    return this.#confirmed(action);
  }
}
