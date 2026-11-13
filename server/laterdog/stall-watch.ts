import { failedTurnTool } from "../../shared/failed-turn.ts";
import type { WireMessage } from "../../shared/wire.ts";
import type { WorkStopCause } from "../../shared/work-state.ts";
import { endsOnPromise } from "./promise-nudge.ts";
import { onlyTapbackText } from "./tapback.ts";

type Message = WireMessage;
type NewMessage = Omit<Message, "id" | "at">;

export const STALL_QUIET_MS = 3 * 60_000;
export const STALL_TRIES = 2;
export const STALL_LOOKBACK_MS = 30 * 60_000;
export const STALL_CHECK_MS = 60_000;

export type StallWatchMode = "act" | "observe" | "off";

export function stallWatchMode(value: string | undefined): StallWatchMode {
  const mode = value?.trim().toLowerCase();
  return mode === "observe" || mode === "off" ? mode : "act";
}

export function handoffWorking(status: string, canRun: boolean, dogBusy: boolean): boolean {
  if (status === "needs-you") return false;
  if (status === "queued") return canRun || dogBusy;
  return true;
}

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
  routine: (at: number) => boolean;
  teammates: readonly Teammate[];
  now: number;
}

export type StallVerdict =
  | { kind: "fine"; why: "busy" | "asking" | "helpers" | "usage" | "queued" | "teammates" | "stopped" | "settled" | "recent" | "old" | "explained" | "routine" }
  | { kind: "needs-you"; what: string; dogs: string[] }
  | { kind: "continue"; source: Message; cause: string; line: string; prompt: string }
  | { kind: "explain"; source: Message; cause: string; line: string; stopped: WorkStopCause };

type Need = "sign-in" | "permission" | "account-off" | "other";

const TEAMMATE_GAVE_UP = /\b(?:couldn't finish|never got started|was interrupted|ran out of time)$/;
const SIGN_IN = /sign(?:ed)?[ -]?in|log(?:ged)?[ -]?in|\b401\b|unauthori[sz]ed|api key|credential/i;
const PERMISSION = /permission|forbidden|not allowed|approval|\b403\b/i;
const NEVER_RETRY = /safety|classifier|invalid model|spend limit|you stopped|\bAPI Error:? 4(?!29)\d\d\b/i;
const TURNED_OFF = / is turned off\.?$/i;
const TURNED_OFF_PART = /[^:—–.]+ is turned off(?=\.?$)/i;

function sentence(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const first = flat.split(/(?<=[.!?])\s/)[0] ?? flat;
  const cut = first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
  return cut.replace(/[.\s]+$/, "");
}

function names(list: readonly string[]): string {
  return list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0] ?? "A teammate";
}

function teammateEnd(message: Message): { name: string; cause: string } | undefined {
  if (message.role !== "bot" || message.kind !== "activity" || !message.comm || message.tool?.ok !== false) return undefined;
  const label = message.tool.name.trim();
  return TEAMMATE_GAVE_UP.test(label) ? { name: message.comm.withName, cause: label } : undefined;
}

function failureOf(message: Message): { cause: string; retry: boolean; need: Need } | undefined {
  const tool = message.tool;
  if (message.role !== "bot" || message.kind !== "activity" || !tool || tool.ok !== false) return undefined;
  if (tool.itemId || tool.pickup || tool.quota || tool.statusLine || message.comm || message.queued) return undefined;
  const label = tool.name.trim();
  if (!/^error:/i.test(label)) return undefined;
  const raw = (tool.detail ?? label.replace(/^error:\s*/i, "")).trim();
  const cause = sentence(TURNED_OFF_PART.exec(raw)?.[0] ?? raw) || "an error";
  const need: Need = TURNED_OFF.test(raw) ? "account-off" : tool.setup || SIGN_IN.test(raw) ? "sign-in" : PERMISSION.test(raw) ? "permission" : "other";
  return { cause, need, retry: need === "other" && !NEVER_RETRY.test(raw) };
}

function watchRows(after: readonly Message[]): Message[] {
  return after.filter((message) => message.tool?.pickup === "watch");
}

function dismissedCard(message: Message | undefined): boolean {
  const card = message?.card;
  return Boolean(card && (card.dismissed || card.expired));
}

export interface OwedWork {
  source: Message;
  after: readonly Message[];
  cause: string;
  teammate?: string;
  retry: boolean;
  need: Need;
}

export function owedWork(path: readonly Message[]): OwedWork | undefined {
  const at = path.findLastIndex((message) => message.role === "user");
  if (at === -1) return undefined;
  const source = path[at]!;
  if (source.requestCancelled || source.queued || source.peerAsk || source.aside) return undefined;
  if (source.reactions?.length || onlyTapbackText(source.text)) return undefined;
  const after = path.slice(at + 1);
  if (dismissedCard(after.at(-1))) return undefined;
  if (after.some((message) => message.tool?.pickup === "restart" && message.tool.ok === false)) return undefined;
  const lastTurnAt = after.findLastIndex((message) => message.role === "bot" && Boolean(message.turnId));
  const gaveUp = after.slice(lastTurnAt + 1).map(teammateEnd).findLast(Boolean);
  if (gaveUp) return { source, after, cause: gaveUp.cause, teammate: gaveUp.name, retry: true, need: "other" };
  const lastTextAt = after.findLastIndex((message) => message.role === "bot" && message.kind === "text");
  if (after.slice(lastTextAt + 1).some((message) => message.tool?.quota)) return undefined;
  const outcomeAt = after.findLastIndex((message) => message.role === "bot" && message.turnSucceeded !== undefined);
  const outcome = after[outcomeAt];
  const failAt = after.findLastIndex((message) => failureOf(message) !== undefined);
  if (failAt > lastTextAt && !(outcome?.turnSucceeded === true && outcomeAt > failAt)) {
    const needsYou = after.slice(lastTextAt + 1, failAt + 1).map(failureOf).findLast((failure) => failure && failure.need !== "other");
    return { source, after, ...(needsYou ?? failureOf(after[failAt]!)!) };
  }
  if (outcome?.turnSucceeded !== false) return undefined;
  const words = after.slice(0, outcomeAt + 1).findLast((message) => message.role === "bot" && message.kind === "text" && message.turnId === outcome.turnId);
  if (words && !endsOnPromise(words.text)) return undefined;
  return { source, after, cause: words ? "the turn failed right after a promise" : "the turn failed without a reply", retry: true, need: "other" };
}

export function carryOnLine(name: string): string {
  return `${name} stopped before finishing, so it is carrying on by itself.`;
}

export function teammateCarryOnLine(teammate: string, name: string): string {
  return `${teammate} stopped before replying, so ${name} is picking the work back up.`;
}

export function stoppedLine(name: string): string {
  return `${name} stopped before finishing and has not picked it up again. Send a message to carry on.`;
}

export function signInLine(name: string): string {
  return `${name} stopped because its account needs you to sign in again.`;
}

export function turnedOffLine(name: string, cause: string): string {
  return `${name} stopped because ${cause}. Turn it back on or pick another account.`;
}

export function permissionLine(name: string): string {
  return `${name} stopped because it needs your permission to go on.`;
}

export function needsAccountLine(dogs: readonly string[]): string {
  return `${names(dogs)} can't run until ${dogs.length > 1 ? "they have" : "it has"} a working account`;
}

export function stallPrompt(text: string, teammate?: string): string {
  const handoff = teammate
    ? ` ${teammate}'s work for you ended without a reply: check what it already finished, then hand the rest over again or do it yourself.`
    : "";
  return `[later.dog: your work on the person's message below stopped before it was finished, and nothing has happened since.${handoff} ` +
    "Anything already done (files written, commands run, messages to other dogs) is still in place. Check the current state before you repeat anything, " +
    "then carry on and finish with one clear answer, or say in one line what is stopping you or what you need from the person.]\n\n" + text;
}

function explainLine(name: string, owed: OwedWork): string {
  if (owed.need === "sign-in") return signInLine(name);
  if (owed.need === "permission") return permissionLine(name);
  if (owed.need === "account-off") return turnedOffLine(name, owed.cause);
  return stoppedLine(name);
}

export function judgeChat(chat: ChatNow, options: { quietMs?: number; tries?: number; lookbackMs?: number } = {}): StallVerdict {
  if (chat.busy) return { kind: "fine", why: "busy" };
  if (chat.requestOpen) return { kind: "fine", why: "asking" };
  if (chat.helpers > 0) return { kind: "fine", why: "helpers" };
  if (chat.usageWait) return { kind: "fine", why: "usage" };
  if (chat.queued) return { kind: "fine", why: "queued" };
  if (chat.stoppedByPerson) return { kind: "fine", why: "stopped" };
  const stuck = chat.teammates.filter((teammate) => !teammate.working && !teammate.canRun);
  if (stuck.length) {
    const dogs = [...new Set(stuck.map((teammate) => teammate.name))];
    return { kind: "needs-you", what: needsAccountLine(dogs), dogs };
  }
  if (chat.teammates.length) return { kind: "fine", why: "teammates" };
  const lastAt = Math.max(0, ...chat.path.map((message) => message.at));
  if (chat.now - lastAt < (options.quietMs ?? STALL_QUIET_MS)) return { kind: "fine", why: "recent" };
  if (chat.now - lastAt > (options.lookbackMs ?? STALL_LOOKBACK_MS)) return { kind: "fine", why: "old" };
  const owed = owedWork(chat.path);
  if (!owed) return { kind: "fine", why: "settled" };
  if (chat.routine(owed.source.at)) return { kind: "fine", why: "routine" };
  const rows = watchRows(owed.after);
  if (rows.some((row) => row.tool?.ok === false)) return { kind: "fine", why: "explained" };
  if (chat.mayContinue && owed.retry && rows.length < (options.tries ?? STALL_TRIES)) {
    const line = owed.teammate ? teammateCarryOnLine(owed.teammate, chat.name) : carryOnLine(chat.name);
    return { kind: "continue", source: owed.source, cause: owed.cause, line, prompt: stallPrompt(owed.source.text ?? "", owed.teammate) };
  }
  return { kind: "explain", source: owed.source, cause: owed.cause, line: explainLine(chat.name, owed), stopped: owed.teammate ? "engine" : "infrastructure" };
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

export function createStallWatch(host: StallWatchHost, options: { everyMs?: number; quietMs?: number; tries?: number; lookbackMs?: number; mode?: StallWatchMode; ready?: Promise<unknown> } = {}) {
  const log = host.log ?? ((line: string) => console.info(line));
  const mode = options.mode ?? "act";
  const facts = new Map<string, StallFacts>();
  const observed = new Set<string>();
  const starting = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let started = false;

  const record = (threadId: string, next: StallFacts | undefined) => {
    const before = JSON.stringify(facts.get(threadId) ?? {});
    if (next && Object.keys(next).length) facts.set(threadId, next);
    else facts.delete(threadId);
    if (before !== JSON.stringify(next ?? {})) host.changed?.(threadId);
  };

  const observe = (threadId: string, verdict: StallVerdict) => {
    if (verdict.kind === "fine") return;
    const about = verdict.kind === "needs-you" ? verdict.what : `${verdict.source.id}: ${verdict.cause}`;
    const key = `${threadId}|${verdict.kind}|${about}`;
    if (observed.has(key)) return;
    observed.add(key);
    if (observed.size > 2_000) observed.delete(observed.values().next().value!);
    log(`stall watch (observe): ${threadId} would ${verdict.kind === "continue" ? "carry on" : verdict.kind === "explain" ? "explain and stop" : "show needs you"} (${about})`);
  };

  const act = (botId: string, threadId: string, verdict: StallVerdict) => {
    if (mode === "observe") {
      observe(threadId, verdict);
      return;
    }
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
      host.append(threadId, { role: "bot", kind: "activity", tool: { ...failedTurnTool(verdict.line, { written: true }), pickup: "watch" } });
      record(threadId, { stopped: { cause: verdict.stopped, detail: "stalled" } });
      log(`stall watch: ${threadId} stopped before finishing (${verdict.cause}); said so`);
      return;
    }
    host.append(threadId, { role: "bot", kind: "activity", tool: { name: `recovery: ${verdict.line}`, ok: true, pickup: "watch" } });
    record(threadId, undefined);
    starting.add(threadId);
    log(`stall watch: ${threadId} stopped before finishing (${verdict.cause}); carrying on`);
    void host.start(botId, threadId, verdict.prompt, verdict.source.id).catch((error: unknown) => {
      const line = stoppedLine(host.look(botId, threadId)?.name ?? "The dog");
      host.append(threadId, { role: "bot", kind: "activity", tool: { ...failedTurnTool(line, { written: true }), pickup: "watch" } });
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
      if (started || mode === "off") return;
      started = true;
      const begin = () => {
        if (!started || timer) return;
        timer = setInterval(() => { this.sweep(); }, options.everyMs ?? STALL_CHECK_MS);
        timer.unref?.();
      };
      if (options.ready) void options.ready.then(begin, begin);
      else begin();
    },
    stop(): void {
      started = false;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type StallWatch = ReturnType<typeof createStallWatch>;
