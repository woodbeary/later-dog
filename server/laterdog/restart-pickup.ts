import { existsSync, readFileSync } from "node:fs";

import { failedTurnTool } from "../../shared/failed-turn.ts";
import type { WireMessage } from "../../shared/wire.ts";
import { writeFileAtomic } from "../atomic.ts";
import { endsOnPromise } from "./promise-nudge.ts";

type Message = WireMessage;
type NewMessage = Omit<Message, "id" | "at">;

export const PICKUP_MAX_AGE_MS = 6 * 60 * 60_000;
export const PICKUP_RETRY_MS = 30_000;
export const PICKUP_RETRY_FOR_MS = 4 * 60 * 60_000;
export const PLANNED_PICKUP_TRIES = 3;

export interface InflightTurn {
  threadId: string;
  botId: string;
  since: number;
  planned?: boolean;
}

export interface InflightLedger {
  read(): InflightTurn[];
  write(turns: InflightTurn[]): void;
}

export interface InflightTask {
  threadId: string;
  busy?: boolean;
  activity?: string;
}

export function restartPickupPrompt(text: string): string {
  return "[later.dog restarted while you were working on the person's message below, so your turn stopped partway. " +
    "Anything it already did (files written, commands run) is still in place, but its tool results may not be in this session. " +
    "Check the current state before you repeat anything, then carry on and finish with one clear answer.]\n\n" + text;
}

export function pickingUpNotice(name: string): string {
  return `later.dog restarted while ${name} was working on this, so ${name} is picking it up again.`;
}

export function restartedAgainLine(name: string): string {
  return `later.dog restarted again before ${name} finished this. Send it again to try once more.`;
}

export function notOwnerLine(name: string): string {
  return `later.dog restarted before ${name} replied. Send your message again to retry.`;
}

export function tooOldLine(name: string): string {
  return `later.dog was off for a while, so ${name} did not pick this up again. Send it again to carry on.`;
}

export function couldNotLine(name: string, reason: string): string {
  const why = reason.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "") || "it could not start";
  return `later.dog restarted before ${name} replied and could not pick it up again: ${why}. Send it again to retry.`;
}

export function inFlight(task: InflightTask): boolean {
  return task.busy === true || task.activity === "working" || task.activity === "waiting-on-you" || task.activity === "parked.computer";
}

export function answersPerson(message: Message, carriesOnAfterLimit = false): boolean {
  if (message.role === "user") return false;
  switch (message.kind) {
    case "text":
      return Boolean(message.text?.trim() || message.attachments?.length);
    case "screen":
    case "digest":
    case "compaction":
      return false;
    case "activity": {
      if (message.comm || message.threadRef || message.cloudTask) return true;
      const tool = message.tool;
      if (!tool || tool.statusLine || tool.ok !== false || tool.itemId) return false;
      return !(carriesOnAfterLimit && tool.quota);
    }
    case "options": {
      const card = message.card;
      return Boolean(card && !card.answered && !card.dismissed && !card.expired);
    }
    case "connector": {
      const connector = message.connector;
      return Boolean(connector && !connector.dismissed && !connector.resumed && connector.status !== "connected");
    }
    case "secret": {
      const secret = message.secret;
      return Boolean(secret && !secret.provided && !secret.dismissed && !secret.superseded);
    }
    default:
      return true;
  }
}

function finalWords(message: Message, lastTurnId: string | undefined): boolean {
  if (!message.text?.trim() && !message.attachments?.length) return false;
  if (lastTurnId !== undefined && message.turnId !== lastTurnId) return false;
  if (message.turnTerminal === true) return true;
  return message.turnId === undefined && !endsOnPromise(message.text);
}

export function answeredSince(after: readonly Message[], carriesOnAfterLimit = false): boolean {
  const lastTurnId = after.findLast((message) => message.turnId && !message.tool?.statusLine)?.turnId;
  return after.some((message) => message.role === "bot" && message.kind === "text"
    ? finalWords(message, lastTurnId)
    : answersPerson(message, carriesOnAfterLimit));
}

export type PickupPlan =
  | { kind: "none"; why: "no-message" | "from-a-dog" | "stopped" | "queued" | "busy" | "routine" | "answered" }
  | { kind: "resume"; source: Message }
  | { kind: "explain"; source: Message; line: string };

export interface PickupInput {
  path: readonly Message[];
  name: string;
  owner: boolean;
  queued: boolean;
  busy?: boolean;
  routine: (at: number) => boolean;
  carriesOnAfterLimit?: boolean;
  planned?: boolean;
  now: number;
}

export function planPickup(input: PickupInput): PickupPlan {
  const { path, name } = input;
  const at = path.findLastIndex((message) => message.role === "user");
  if (at === -1) return { kind: "none", why: "no-message" };
  const source = path[at]!;
  if (source.peerAsk || source.aside) return { kind: "none", why: "from-a-dog" };
  if (source.requestCancelled) return { kind: "none", why: "stopped" };
  if (input.queued || source.queued) return { kind: "none", why: "queued" };
  if (input.busy) return { kind: "none", why: "busy" };
  if (input.routine(source.at)) return { kind: "none", why: "routine" };
  const after = path.slice(at + 1);
  if (answeredSince(after, input.carriesOnAfterLimit)) return { kind: "none", why: "answered" };
  const tries = after.filter((message) => message.tool?.pickup === "restart").length;
  if (tries >= (input.planned ? PLANNED_PICKUP_TRIES : 1)) return { kind: "explain", source, line: restartedAgainLine(name) };
  if (!input.owner) return { kind: "explain", source, line: notOwnerLine(name) };
  const lastSeen = Math.max(source.at, ...after.map((message) => message.at));
  if (input.now - lastSeen > PICKUP_MAX_AGE_MS) return { kind: "explain", source, line: tooOldLine(name) };
  return { kind: "resume", source };
}

function isInflightTurn(value: unknown): value is InflightTurn {
  const turn = value as Partial<InflightTurn> | null;
  return Boolean(turn) && typeof turn!.threadId === "string" && typeof turn!.botId === "string" && typeof turn!.since === "number";
}

export function fileInflightLedger(path: string): InflightLedger {
  return {
    read() {
      if (!existsSync(path)) return [];
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        return Array.isArray(parsed) ? parsed.filter(isInflightTurn) : [];
      } catch {
        return [];
      }
    },
    write(turns) {
      writeFileAtomic(path, `${JSON.stringify(turns)}\n`, { mode: 0o600, durable: false });
    },
  };
}

export function createInflightTurns(ledger: InflightLedger, options: { now?: () => number; stopping?: () => boolean } = {}) {
  const now = options.now ?? Date.now;
  const stopping = options.stopping ?? (() => false);
  let leftovers: InflightTurn[] = [];
  try { leftovers = ledger.read(); } catch (error) {
    console.error("[restart-pickup] could not read the turns left running", error);
  }
  const open = new Map<string, InflightTurn>();

  const save = () => {
    try { ledger.write([...leftovers, ...open.values()]); } catch (error) {
      console.error("[restart-pickup] could not save the running turns", error);
    }
  };

  return {
    sync(botId: string, tasks: readonly InflightTask[]): void {
      let changed = false;
      const running = new Set<string>();
      for (const task of tasks) {
        if (!inFlight(task)) continue;
        running.add(task.threadId);
        if (open.get(task.threadId)?.botId === botId) continue;
        open.set(task.threadId, { threadId: task.threadId, botId, since: now() });
        changed = true;
      }
      if (!stopping()) {
        for (const [threadId, turn] of open) {
          if (turn.botId !== botId || running.has(threadId)) continue;
          open.delete(threadId);
          changed = true;
        }
      }
      if (changed) save();
    },

    forget(botId: string): void {
      if (stopping()) return;
      let changed = false;
      for (const [threadId, turn] of open) {
        if (turn.botId !== botId) continue;
        open.delete(threadId);
        changed = true;
      }
      if (changed) save();
    },

    markPlanned(): void {
      if (!open.size) return;
      for (const [threadId, turn] of open) open.set(threadId, { ...turn, planned: true });
      save();
    },

    takeLeftovers(): InflightTurn[] {
      const taken = leftovers;
      leftovers = [];
      if (taken.length) save();
      return taken;
    },

    running(): InflightTurn[] {
      return [...open.values()];
    },
  };
}

export type InflightTurns = ReturnType<typeof createInflightTurns>;

export interface RestartPickupHost {
  path(threadId: string): readonly Message[];
  dog(threadId: string): { botId: string; name: string } | null;
  owner(threadId: string): boolean;
  queued(botId: string, threadId: string): boolean;
  busy(botId: string, threadId: string): boolean;
  routine(threadId: string, at: number): boolean;
  carriesOnAfterLimit(): boolean;
  append(threadId: string, message: NewMessage): Message;
  patch(threadId: string, messageId: string, patch: Partial<Message>): unknown;
  start(botId: string, threadId: string, prompt: string, requestMessageId: string): Promise<unknown>;
  blocked(error: unknown): boolean;
  now?: () => number;
  later?: (run: () => void, ms: number) => void;
  retryMs?: number;
  retryForMs?: number;
  log?: (line: string) => void;
}

export type PickupOutcome =
  | { threadId: string; kind: "none"; why: string }
  | { threadId: string; kind: "explained"; line: string }
  | { threadId: string; kind: "resumed"; sourceId: string }
  | { threadId: string; kind: "waiting"; sourceId: string };

const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function pickUpAfterRestart(host: RestartPickupHost, turns: readonly InflightTurn[]): Promise<PickupOutcome[]> {
  const now = host.now ?? Date.now;
  const later = host.later ?? ((run: () => void, ms: number) => { setTimeout(run, ms).unref?.(); });
  const retryMs = host.retryMs ?? PICKUP_RETRY_MS;
  const retryFor = host.retryForMs ?? PICKUP_RETRY_FOR_MS;
  const log = host.log ?? ((line: string) => console.info(line));
  const outcomes: PickupOutcome[] = [];
  const seen = new Set<string>();

  const stillWaiting = (threadId: string, sourceId: string) => {
    const path = host.path(threadId);
    const at = path.findLastIndex((message) => message.role === "user");
    return at !== -1 && path[at]!.id === sourceId && !answeredSince(path.slice(at + 1), host.carriesOnAfterLimit());
  };

  type Attempt = { kind: "resumed" } | { kind: "waiting" } | { kind: "failed"; line: string };
  const attempt = async (dog: { botId: string; name: string }, threadId: string, source: Message, noticeId: string, until: number): Promise<Attempt> => {
    try {
      await host.start(dog.botId, threadId, restartPickupPrompt(source.text ?? ""), source.id);
      log(`restart pickup: ${threadId} picked up again`);
      return { kind: "resumed" };
    } catch (error) {
      if (host.blocked(error) && now() < until) {
        later(() => {
          if (!stillWaiting(threadId, source.id) || host.queued(dog.botId, threadId)) return;
          void attempt(dog, threadId, source, noticeId, until);
        }, retryMs);
        log(`restart pickup: ${threadId} waits for a free slot`);
        return { kind: "waiting" };
      }
      const reason = host.blocked(error) ? `${dog.name} stayed busy with other work` : reasonOf(error);
      const line = couldNotLine(dog.name, reason);
      host.patch(threadId, noticeId, { tool: { ...failedTurnTool(line), pickup: "restart" } });
      log(`restart pickup: ${threadId} could not start: ${reason}`);
      return { kind: "failed", line };
    }
  };

  for (const turn of turns) {
    if (seen.has(turn.threadId)) continue;
    seen.add(turn.threadId);
    try {
      const dog = host.dog(turn.threadId);
      if (!dog) {
        outcomes.push({ threadId: turn.threadId, kind: "none", why: "gone" });
        continue;
      }
      const plan = planPickup({
        path: host.path(turn.threadId),
        name: dog.name,
        owner: host.owner(turn.threadId),
        queued: host.queued(dog.botId, turn.threadId),
        busy: host.busy(dog.botId, turn.threadId),
        routine: (at) => host.routine(turn.threadId, at),
        carriesOnAfterLimit: host.carriesOnAfterLimit(),
        planned: turn.planned === true,
        now: now(),
      });
      if (plan.kind === "none") {
        outcomes.push({ threadId: turn.threadId, kind: "none", why: plan.why });
        continue;
      }
      if (plan.kind === "explain") {
        host.append(turn.threadId, { role: "bot", kind: "activity", tool: { ...failedTurnTool(plan.line), pickup: "restart" } });
        outcomes.push({ threadId: turn.threadId, kind: "explained", line: plan.line });
        continue;
      }
      const notice = host.append(turn.threadId, {
        role: "bot", kind: "activity", tool: { name: `recovery: ${pickingUpNotice(dog.name)}`, ok: true, pickup: "restart" },
      });
      const result = await attempt(dog, turn.threadId, plan.source, notice.id, now() + retryFor);
      outcomes.push(result.kind === "failed"
        ? { threadId: turn.threadId, kind: "explained", line: result.line }
        : { threadId: turn.threadId, kind: result.kind, sourceId: plan.source.id });
    } catch (error) {
      log(`restart pickup: ${turn.threadId} could not be checked: ${reasonOf(error)}`);
      outcomes.push({ threadId: turn.threadId, kind: "none", why: "error" });
    }
  }
  return outcomes;
}
