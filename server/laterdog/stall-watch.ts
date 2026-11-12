import { failedTurnTool } from "../../shared/failed-turn.ts";
import type { WireMessage } from "../../shared/wire.ts";
import type { WorkStopCause } from "../../shared/work-state.ts";
import { endsOnPromise } from "./promise-nudge.ts";
import { answeredSince } from "./restart-pickup.ts";

type Message = WireMessage;
type NewMessage = Omit<Message, "id" | "at">;

export const STALL_QUIET_MS = 3 * 60_000;
export const STALL_TRIES = 2;
export const STALL_LOOKBACK_MS = 6 * 60 * 60_000;
export const STALL_CHECK_MS = 60_000;

export interface Teammate {
  id: string;
  name: string;
  working: boolean;
  canRun: boolean;
}

export interface ChatNow {
  name: string;
  path: readonly Message[];
  busy: boolean;
  requestOpen: boolean;
  helpers: number;
  usageWait: boolean;
  queued: boolean;
  stoppedByPerson: boolean;
  mayContinue: boolean;
  teammates: readonly Teammate[];
  now: number;
}

export type StallVerdict =
  | { kind: "fine"; why: "busy" | "asking" | "helpers" | "usage" | "queued" | "teammates" | "stopped" | "settled" | "recent" | "old" | "explained" }
  | { kind: "needs-you"; what: string; dogs: string[] }
  | { kind: "continue"; source: Message; cause: string; line: string; prompt: string }
  | { kind: "explain"; source: Message; cause: string; line: string; stopped: WorkStopCause };

const TEAMMATE_GAVE_UP = /\b(?:couldn't finish|never got started|was interrupted|ran out of time)$/;

function sentence(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const first = flat.split(/(?<=[.!?])\s/)[0] ?? flat;
  const cut = first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
  return cut.replace(/[.\s]+$/, "");
}

function teammateEnd(message: Message): string | undefined {
  if (message.role !== "bot" || message.kind !== "activity" || !message.comm || message.tool?.ok !== false) return undefined;
  const name = message.tool.name.trim();
  return TEAMMATE_GAVE_UP.test(name) ? name : undefined;
}

const NO_RETRY = /safety|classifier|sign(?:ed)?[ -]?in|log(?:ged)?[ -]?in|\b401\b|unauthori[sz]ed|forbidden|permission|invalid model|api key|spend limit|stopped it|you stopped/i;

function failureOf(message: Message): { cause: string; retry: boolean } | undefined {
  const tool = message.tool;
  if (message.role !== "bot" || message.kind !== "activity" || !tool || tool.ok !== false) return undefined;
  if (tool.itemId || tool.pickup || tool.quota || tool.statusLine || message.comm || message.queued) return undefined;
  const name = tool.name.trim();
  if (!/^error:/i.test(name)) return undefined;
  const said = sentence(name.replace(/^error:\s*/i, ""));
  return { cause: said ? `it hit a problem: ${said}` : "it hit a problem", retry: !tool.setup && !NO_RETRY.test(name) };
}

function watchRows(after: readonly Message[]): Message[] {
  return after.filter((message) => message.tool?.pickup === "watch");
}

export interface OwedWork {
  source: Message;
  after: readonly Message[];
  cause: string;
  teammate?: boolean;
  retry: boolean;
}

export function owedWork(path: readonly Message[]): OwedWork | undefined {
  const at = path.findLastIndex((message) => message.role === "user");
  if (at === -1) return undefined;
  const source = path[at]!;
  if (source.requestCancelled || source.queued || source.peerAsk || source.aside) return undefined;
  const after = path.slice(at + 1);
  const lastTurnAt = after.findLastIndex((message) => message.role === "bot" && Boolean(message.turnId));
  const gaveUp = after.slice(lastTurnAt + 1).map(teammateEnd).findLast(Boolean);
  if (gaveUp) return { source, after, cause: `${gaveUp} before replying`, teammate: true, retry: true };
  const lastTextAt = after.findLastIndex((message) => message.role === "bot" && message.kind === "text");
  const failAt = after.findLastIndex((message) => failureOf(message) !== undefined);
  if (after.slice(lastTextAt + 1).some((message) => message.tool?.quota)) return undefined;
  if (failAt > lastTextAt) return { source, after, ...failureOf(after[failAt]!)! };
  if (!answeredSince(after)) return { source, after, cause: "its turn ended before it answered", retry: true };
  const lastText = after[lastTextAt];
  if (!lastText || lastText.turnSucceeded !== false || !endsOnPromise(lastText.text)) return undefined;
  const failure = failAt === -1 ? undefined : failureOf(after[failAt]!);
  return { source, after, cause: failure?.cause ?? "its turn ended right after it said what it would do", retry: failure?.retry ?? true };
}

export function carryOnLine(name: string, cause: string): string {
  return `${name} stopped partway (${cause}), so ${name} is carrying on by itself.`;
}

export function stoppedLine(name: string, cause: string): string {
  return `${name} stopped partway (${cause}) and has not picked it up again. Send a message to carry on.`;
}

export function needsAccountLine(names: readonly string[]): string {
  const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "A teammate";
  return `${who} can't run until ${names.length > 1 ? "they have" : "it has"} a working account`;
}

export function stallPrompt(cause: string, text: string, teammate = false): string {
  const handoff = teammate
    ? " A teammate's work for you ended without a reply: check what it already finished, then hand the rest over again or do it yourself."
    : "";
  return `[later.dog: your work on the person's message below stopped partway: ${cause}. Nothing has happened since.${handoff} ` +
    "Anything already done (files written, commands run, messages to other dogs) is still in place. Check the current state before you repeat anything, " +
    "then carry on and finish with one clear answer, or say in one line what is stopping you or what you need from the person.]\n\n" + text;
}

export function judgeChat(chat: ChatNow, options: { quietMs?: number; tries?: number; lookbackMs?: number } = {}): StallVerdict {
  if (chat.busy) return { kind: "fine", why: "busy" };
  if (chat.requestOpen) return { kind: "fine", why: "asking" };
  if (chat.helpers > 0) return { kind: "fine", why: "helpers" };
  if (chat.usageWait) return { kind: "fine", why: "usage" };
  if (chat.queued) return { kind: "fine", why: "queued" };
  if (chat.stoppedByPerson) return { kind: "fine", why: "stopped" };
  if (chat.teammates.some((teammate) => teammate.working)) return { kind: "fine", why: "teammates" };
  const stuck = chat.teammates.filter((teammate) => !teammate.canRun);
  if (stuck.length) {
    const dogs = [...new Set(stuck.map((teammate) => teammate.name))];
    return { kind: "needs-you", what: needsAccountLine(dogs), dogs };
  }
  const lastAt = Math.max(0, ...chat.path.map((message) => message.at));
  if (chat.now - lastAt < (options.quietMs ?? STALL_QUIET_MS)) return { kind: "fine", why: "recent" };
  if (chat.now - lastAt > (options.lookbackMs ?? STALL_LOOKBACK_MS)) return { kind: "fine", why: "old" };
  const idleTeammates = chat.teammates.filter((teammate) => teammate.canRun);
  const owed = owedWork(chat.path) ?? (idleTeammates.length ? silentTeammates(chat.path, idleTeammates) : undefined);
  if (!owed) return { kind: "fine", why: "settled" };
  const rows = watchRows(owed.after);
  if (rows.some((row) => row.tool?.ok === false)) return { kind: "fine", why: "explained" };
  if (chat.mayContinue && owed.retry && rows.length < (options.tries ?? STALL_TRIES)) {
    return { kind: "continue", source: owed.source, cause: owed.cause, line: carryOnLine(chat.name, owed.cause), prompt: stallPrompt(owed.cause, owed.source.text ?? "", owed.teammate) };
  }
  return { kind: "explain", source: owed.source, cause: owed.cause, line: stoppedLine(chat.name, owed.cause), stopped: owed.teammate ? "engine" : "infrastructure" };
}

function silentTeammates(path: readonly Message[], idle: readonly Teammate[]): OwedWork | undefined {
  const at = path.findLastIndex((message) => message.role === "user");
  if (at === -1) return undefined;
  const names = [...new Set(idle.map((teammate) => teammate.name))];
  const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]!;
  return { source: path[at]!, after: path.slice(at + 1), cause: `${who} ${names.length > 1 ? "have" : "has"} not picked up the work it was given`, teammate: true, retry: true };
}

export interface StallFacts {
  needsYou?: { what?: string };
  stopped?: { cause: WorkStopCause; detail: "stalled" };
}

export interface StallWatchHost {
  chats(): Iterable<{ botId: string; threadId: string }>;
  look(botId: string, threadId: string): ChatNow | null;
  append(threadId: string, message: NewMessage): Message;
  start(botId: string, threadId: string, prompt: string, requestMessageId: string): Promise<unknown>;
  changed?(threadId: string): void;
  log?: (line: string) => void;
}

const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const MOVING: ReadonlySet<string> = new Set(["busy", "asking", "helpers", "usage", "queued", "teammates"]);

export function createStallWatch(host: StallWatchHost, options: { everyMs?: number; quietMs?: number; tries?: number } = {}) {
  const log = host.log ?? ((line: string) => console.info(line));
  const facts = new Map<string, StallFacts>();
  const starting = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const record = (threadId: string, next: StallFacts | undefined) => {
    const before = JSON.stringify(facts.get(threadId) ?? {});
    if (next && Object.keys(next).length) facts.set(threadId, next);
    else facts.delete(threadId);
    if (before !== JSON.stringify(next ?? {})) host.changed?.(threadId);
  };

  const act = (botId: string, threadId: string, verdict: StallVerdict) => {
    if (verdict.kind === "fine") {
      const stopped = facts.get(threadId)?.stopped;
      record(threadId, MOVING.has(verdict.why) || !stopped ? undefined : { stopped });
      return;
    }
    if (verdict.kind === "needs-you") {
      record(threadId, { needsYou: { what: verdict.what } });
      return;
    }
    if (verdict.kind === "explain") {
      host.append(threadId, { role: "bot", kind: "activity", tool: { ...failedTurnTool(verdict.line), pickup: "watch" } });
      record(threadId, { stopped: { cause: verdict.stopped, detail: "stalled" } });
      log(`stall watch: ${threadId} stopped partway (${verdict.cause}); said so`);
      return;
    }
    host.append(threadId, { role: "bot", kind: "activity", tool: { name: `recovery: ${verdict.line}`, ok: true, pickup: "watch" } });
    record(threadId, undefined);
    starting.add(threadId);
    log(`stall watch: ${threadId} stopped partway (${verdict.cause}); carrying on`);
    void host.start(botId, threadId, verdict.prompt, verdict.source.id).catch((error: unknown) => {
      const line = stoppedLine(host.look(botId, threadId)?.name ?? "The dog", `it could not start again: ${sentence(reasonOf(error))}`);
      host.append(threadId, { role: "bot", kind: "activity", tool: { ...failedTurnTool(line), pickup: "watch" } });
      record(threadId, { stopped: { cause: "infrastructure", detail: "stalled" } });
      log(`stall watch: ${threadId} could not carry on: ${reasonOf(error)}`);
    }).finally(() => starting.delete(threadId));
  };

  return {
    sweep(): StallVerdict[] {
      const verdicts: StallVerdict[] = [];
      for (const { botId, threadId } of host.chats()) {
        if (starting.has(threadId)) continue;
        try {
          const chat = host.look(botId, threadId);
          if (!chat) continue;
          const verdict = judgeChat(chat, options);
          act(botId, threadId, verdict);
          verdicts.push(verdict);
        } catch (error) {
          log(`stall watch: ${threadId} could not be checked: ${reasonOf(error)}`);
        }
      }
      return verdicts;
    },
    facts(threadId: string): StallFacts {
      return facts.get(threadId) ?? {};
    },
    forget(threadId: string): void {
      facts.delete(threadId);
    },
    start(): void {
      if (timer) return;
      timer = setInterval(() => { this.sweep(); }, options.everyMs ?? STALL_CHECK_MS);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type StallWatch = ReturnType<typeof createStallWatch>;
