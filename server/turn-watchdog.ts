export interface WatchedTurn {
  threadId: string;
  botId: string;
  startedAt: number;
  lastEventAt: number;
  waitingOnHuman: boolean;
  waitingOnComputer: boolean;
  waitingOnHelpers: boolean;
  helpersStartedAt?: number;
  toolsRunning?: Map<string, number>;
}

export const DEFAULT_TOOL_MAX_MS = 4 * 60 * 60_000;

export function toolRunningSince(turn: WatchedTurn): number | undefined {
  if (!turn.toolsRunning?.size) return undefined;
  return Math.min(...turn.toolsRunning.values());
}

export interface TurnWatchdogOptions {
  stallMs: number;
  checkMs: number;
  helpersMaxMs?: number;
  toolMaxMs?: number;
  onStall: (turn: WatchedTurn) => void;
  now?: () => number;
}

export class TurnWatchdog {
  private turns = new Map<string, WatchedTurn>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private opts: TurnWatchdogOptions;

  constructor(opts: TurnWatchdogOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.opts.checkMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.turns.clear();
  }

  watch(threadId: string, botId: string): void {
    const at = this.now();
    this.turns.set(threadId, { threadId, botId, startedAt: at, lastEventAt: at, waitingOnHuman: false, waitingOnComputer: false, waitingOnHelpers: false });
  }

  touch(threadId: string): void {
    const turn = this.turns.get(threadId);
    if (turn) turn.lastEventAt = this.now();
  }

  toolStarted(threadId: string, itemId = ""): void {
    const turn = this.turns.get(threadId);
    if (!turn) return;
    turn.lastEventAt = this.now();
    (turn.toolsRunning ??= new Map()).set(itemId, turn.lastEventAt);
  }

  toolEnded(threadId: string, itemId = ""): void {
    const turn = this.turns.get(threadId);
    if (!turn) return;
    turn.lastEventAt = this.now();
    turn.toolsRunning?.delete(itemId);
  }

  observeTool(event: { type: string; threadId: string; itemType?: string; itemId?: string }): void {
    if (event.itemType !== "tool") return;
    if (event.type === "item.started") this.toolStarted(event.threadId, event.itemId);
    else if (event.type === "item.completed") this.toolEnded(event.threadId, event.itemId);
  }

  toolOverran(turn: WatchedTurn, at = this.now()): boolean {
    const since = toolRunningSince(turn);
    return since !== undefined && at - since >= (this.opts.toolMaxMs ?? DEFAULT_TOOL_MAX_MS);
  }

  setWaitingOnHuman(threadId: string, waiting: boolean): void {
    const turn = this.turns.get(threadId);
    if (!turn) return;
    turn.waitingOnHuman = waiting;
    turn.lastEventAt = this.now();
  }

  setWaitingOnComputer(threadId: string, waiting: boolean): void {
    const turn = this.turns.get(threadId);
    if (!turn) return;
    turn.waitingOnComputer = waiting;
    turn.lastEventAt = this.now();
  }

  setWaitingOnHelpers(threadId: string, waiting: boolean): void {
    const turn = this.turns.get(threadId);
    if (!turn) return;
    if (waiting && !turn.waitingOnHelpers) turn.helpersStartedAt = this.now();
    if (!waiting) turn.helpersStartedAt = undefined;
    turn.waitingOnHelpers = waiting;
    turn.lastEventAt = this.now();
  }

  settle(threadId: string): void {
    this.turns.delete(threadId);
  }

  watching(threadId: string): boolean {
    return this.turns.has(threadId);
  }

  snapshot(threadId: string): WatchedTurn | undefined {
    return this.turns.get(threadId);
  }

  sweep(): void {
    const at = this.now();
    for (const turn of this.turns.values()) {
      const helperDeadline = turn.waitingOnHelpers && turn.helpersStartedAt !== undefined && at - turn.helpersStartedAt >= (this.opts.helpersMaxMs ?? 4 * 60 * 60_000);
      const toolAlive = toolRunningSince(turn) !== undefined && !this.toolOverran(turn, at);
      if (!helperDeadline) {
        if (turn.waitingOnHuman || turn.waitingOnComputer || turn.waitingOnHelpers || toolAlive) continue;
        if (at - turn.lastEventAt < this.opts.stallMs) continue;
      }
      this.turns.delete(turn.threadId);
      this.opts.onStall(turn);
    }
  }
}
