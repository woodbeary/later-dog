import { redactSecretsInText } from "../../shared/redact.ts";
import type { Decider } from "../decider/index.ts";
import type { ChoiceAnswer, ChoiceQuestion } from "../decider/types.ts";
import type { Breaker } from "./clef-breaker.ts";
import { createBoundedMap } from "./clef-bounded.ts";
import { fastDecide } from "./clef-fast-decide.ts";
import type { ClefLogRow } from "./clef-log.ts";

export const KEEP_GOING_NUDGE = "Keep going until it's done.";
export const STOPPED_MIDWAY_MIN_PROBABILITY = 0.8;
export const MAX_NUDGES_IN_A_ROW = 3;
export const TURN_END_BUDGET_MS = 1_500;

const TASK_MAX = 1_500;
const REPLY_MAX = 3_000;
const ACTIVITY_MAX = 160;
const ACTIVITY_LINES = 8;

export type TurnEndChoice = "done" | "question_for_person" | "stopped_midway" | "blocked";

export const TURN_END_QUESTION: ChoiceQuestion<TurnEndChoice> = {
  type: "choice",
  instructions: "The dog just ended its turn. Looking at `task`, `last_reply` and `recent_activity`, how did the turn end?",
  options: {
    done: "The dog finished the task and reported the result, or the task was only a question it answered.",
    question_for_person: "The dog is waiting for the person to answer a question or make a choice before it can go on.",
    stopped_midway: "The dog stopped before the task was finished, for example it said what it would do next, listed steps still to do, or ended partway through the work, and nothing is stopping it from going on.",
    blocked: "The dog cannot go on without something it does not have, for example access, a missing file, or a failure it could not get past.",
  },
};

export interface TurnMessage {
  role: string;
  kind: string;
  text?: string;
  tool?: { name?: string; spoken?: string };
}

export interface TurnEndInput {
  threadId: string;
  botId: string;
  ok: boolean;
  reply: string;
  path: readonly TurnMessage[];
  isCurrent(): boolean;
  stoppedByPerson(): boolean;
  usageLimited: boolean;
  skip?: boolean;
}

export type TurnEndOutcome =
  | { action: "nudged"; choice: TurnEndChoice; probability: number; streak: number }
  | { action: "left"; choice: TurnEndChoice; probability: number }
  | { action: "skipped"; reason: string };

export interface TurnEndDeps {
  decider: Pick<Decider, "ask"> | undefined;
  enabled(): boolean;
  hasBudget(): boolean;
  accountAvailable(input: TurnEndInput): boolean;
  canStart(input: TurnEndInput): boolean;
  waitingOn(input: TurnEndInput): string | null;
  threadAlive?(threadId: string): boolean;
  announce?(input: TurnEndInput, text: string): void;
  nudge(input: TurnEndInput, text: string): Promise<void>;
  record(row: ClefLogRow): void;
  budgetMs?: number;
  breaker?: Breaker;
}

const WAITING_ON_PERSON_KINDS: ReadonlySet<string> = new Set(["secret", "connector"]);

const clip = (text: string, max: number) => {
  const flat = redactSecretsInText(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function turnEndState(input: Pick<TurnEndInput, "reply" | "path">) {
  const task = input.path.findLast((message) => message.role === "user" && message.kind === "text")?.text ?? "";
  const activity = input.path
    .filter((message) => message.kind === "activity" && message.tool?.name)
    .slice(-ACTIVITY_LINES)
    .map((message) => clip(message.tool?.spoken || message.tool?.name || "", ACTIVITY_MAX));
  return { task: clip(task, TASK_MAX), last_reply: clip(input.reply, REPLY_MAX), recent_activity: activity };
}

export function createTurnEndWatcher(deps: TurnEndDeps) {
  const streak = createBoundedMap<number>({ max: 200, ttlMs: 6 * 60 * 60_000 });
  const nudged = createBoundedMap<true>({ max: 200, ttlMs: 6 * 60 * 60_000 });

  const record = (row: ClefLogRow) => {
    try {
      deps.record(row);
    } catch {
      return;
    }
  };

  const skip = (input: TurnEndInput, reason: string): TurnEndOutcome => {
    record({ kind: "turnEnd", threadId: input.threadId, botId: input.botId, action: "skipped", reason });
    return { action: "skipped", reason };
  };

  const endedWaiting = (input: TurnEndInput): string | null => {
    const last = input.path.slice(-2);
    if (last.some((message) => WAITING_ON_PERSON_KINDS.has(message.kind))) return "waiting_on_person";
    try {
      return deps.waitingOn(input);
    } catch {
      return "waiting_check_failed";
    }
  };

  return {
    streakOf: (threadId: string) => streak.get(threadId) ?? 0,
    forget(threadId: string): void {
      streak.delete(threadId);
      nudged.delete(threadId);
    },
    async afterTurn(input: TurnEndInput): Promise<TurnEndOutcome> {
      if (!deps.enabled()) return { action: "skipped", reason: "off" };
      if (deps.threadAlive) {
        const alive = deps.threadAlive;
        streak.sweep(alive);
        nudged.sweep(alive);
      }
      const continuing = nudged.get(input.threadId) === true;
      nudged.delete(input.threadId);
      if (!continuing) streak.set(input.threadId, 0);
      if (input.skip) return { action: "skipped", reason: "not_direct_work" };
      if (!input.ok) return skip(input, "turn_failed");
      if (input.stoppedByPerson()) return skip(input, "stopped_by_person");
      if (input.usageLimited) return skip(input, "usage_limit");
      if (!input.isCurrent()) return skip(input, "superseded");
      const waiting = endedWaiting(input);
      if (waiting) return skip(input, waiting);
      const decided = await fastDecide(deps.decider, "turnEnd", turnEndState(input), { ended: TURN_END_QUESTION }, {
        budgetMs: deps.budgetMs ?? TURN_END_BUDGET_MS,
        breaker: deps.breaker,
      });
      if (!decided.decided) return skip(input, `decider_${decided.reason}`);
      const answer = decided.answers.ended as ChoiceAnswer<TurnEndChoice>;
      const row = { kind: "turnEnd" as const, threadId: input.threadId, botId: input.botId, choice: answer.choice, pTop: answer.pTop, latencyMs: decided.latencyMs };
      if (answer.choice !== "stopped_midway") {
        streak.set(input.threadId, 0);
        record({ ...row, action: "left" });
        return { action: "left", choice: answer.choice, probability: answer.pTop };
      }
      const count = streak.get(input.threadId) ?? 0;
      const refusal = answer.pTop < STOPPED_MIDWAY_MIN_PROBABILITY ? "unsure"
        : count >= MAX_NUDGES_IN_A_ROW ? "nudge_limit"
          : !deps.hasBudget() ? "no_budget"
            : !deps.accountAvailable(input) ? "no_account"
              : !input.isCurrent() || input.stoppedByPerson() || !deps.canStart(input) ? "thread_moved_on"
                : endedWaiting(input) ?? null;
      if (refusal) {
        record({ ...row, action: "left", reason: refusal });
        return { action: "left", choice: answer.choice, probability: answer.pTop };
      }
      streak.set(input.threadId, count + 1);
      nudged.set(input.threadId, true);
      try {
        deps.announce?.(input, `Nudged to keep going (${count + 1}/${MAX_NUDGES_IN_A_ROW})`);
      } catch {
        record({ ...row, action: "left", reason: "announce_failed" });
      }
      try {
        await deps.nudge(input, KEEP_GOING_NUDGE);
      } catch {
        nudged.delete(input.threadId);
        streak.set(input.threadId, count);
        record({ ...row, action: "left", reason: "nudge_failed" });
        return { action: "left", choice: answer.choice, probability: answer.pTop };
      }
      record({ ...row, action: "nudged", streak: count + 1 });
      return { action: "nudged", choice: answer.choice, probability: answer.pTop, streak: count + 1 };
    },
  };
}
