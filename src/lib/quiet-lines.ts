import type { Message } from "@/state/store";
import type { WireExchange } from "../../shared/room-exchange";
import type { DogColor } from "./mascot";
import { isRecoveryActivity, isStatusActivity, type TranscriptItem } from "./activity-runs";
import { failedTurnCause } from "./failed-turn";
import { isProviderSafetyBlock } from "../../shared/provider-safety";
import { peerLine } from "./peer-message";
import { localDay } from "./transcript-derivations";

export type ExchangeDirection = "to" | "from";

export type ExchangeTarget =
  | { kind: "group"; groupId: string }
  | { kind: "dog"; botId: string; threadId: string };

export interface ExchangeRow {
  message: Message;
  withBotId: string;
  withName: string;
  withColor: DogColor;
  direction: ExchangeDirection;
  action?: "failed";
  target: ExchangeTarget;
}

export interface ExchangeItem {
  kind: "exchange";
  id: string;
  withBotId: string;
  target: ExchangeTarget;
  messages: Message[];
  rows: ExchangeRow[];
  folded: Message[];
}

export interface RecoveredItem {
  kind: "recovered";
  id: string;
  recovery: Message;
  messages: Message[];
  folded: Message[];
  since: number;
}

const MAC_PERMISSION = /^CUA Driver is not ready\b/;

export type QuietTranscriptItem = TranscriptItem | ExchangeItem | RecoveredItem;

const LEGACY_TO = /^Messaged @/;
const LEGACY_FROM = /^Message from @/;
const SENT_TO = /^Sent to (.+)$/;
const TEAMMATE_THREAD = /^(?:Opened|Added to) thread #.* on (.+)$/s;
const ROOM_SUFFIX = / · .*$/;

function teammateName(toolName: string): string | undefined {
  const named = TEAMMATE_THREAD.exec(toolName)?.[1] ?? SENT_TO.exec(toolName)?.[1];
  return named?.replace(ROOM_SUFFIX, "").trim() || undefined;
}

export function exchangeRow(message: Message): ExchangeRow | null {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool) return null;
  const ref = message.threadRef;
  const comm = message.comm;
  if (message.roomRequest?.phase === "result" && tool.ok === false && (ref || comm)) {
    return {
      message, withBotId: comm?.withBotId ?? ref!.botId,
      withName: comm?.withName ?? message.from?.name ?? "", withColor: comm?.withColor ?? message.from?.color ?? "blue",
      direction: "from", action: "failed",
      target: comm ? { kind: "group", groupId: comm.groupId }
        : { kind: "dog", botId: ref!.botId, threadId: ref!.threadId },
    };
  }
  if (ref && tool.name.startsWith("Opened thread #")) return null;
  if (comm) {
    const direction = comm.direction
      ?? ((LEGACY_TO.test(tool.name) || (tool.ok === true && SENT_TO.test(tool.name))) ? "to" : LEGACY_FROM.test(tool.name) ? "from" : undefined);
    return direction
      ? { message, withBotId: comm.withBotId, withName: comm.withName, withColor: comm.withColor, direction, target: { kind: "group", groupId: comm.groupId } }
      : null;
  }
  const name = ref ? teammateName(tool.name) : undefined;
  if (ref && name) {
    return {
      message, withBotId: ref.botId, withName: name, withColor: "blue", direction: "to",
      target: { kind: "dog", botId: ref.botId, threadId: ref.threadId },
    };
  }
  return null;
}

function sameTarget(a: ExchangeRow, b: ExchangeRow): boolean {
  const first = a.target;
  const second = b.target;
  return first.kind === "group"
    ? second.kind === "group" && first.groupId === second.groupId && a.message.comm?.threadId === b.message.comm?.threadId
    : second.kind === "dog" && first.botId === second.botId && first.threadId === second.threadId;
}

export function singleExchange(message: Message): ExchangeItem | null {
  const row = exchangeRow(message);
  return row
    ? { kind: "exchange", id: `exchange:${message.id}`, withBotId: row.withBotId, target: row.target, messages: [message], rows: [row], folded: [] }
    : null;
}

function lastRendered(
  folded: readonly QuietTranscriptItem[],
  renders: (item: TranscriptItem) => boolean,
): QuietTranscriptItem | undefined {
  for (let index = folded.length - 1; index >= 0; index -= 1) {
    const candidate = folded[index]!;
    if (candidate.kind === "exchange" || candidate.kind === "turn" || candidate.kind === "recovered" || renders(candidate)) return candidate;
  }
  return undefined;
}

function isPeerMessageOf(item: ExchangeItem, message: Message, hasGroup: (groupId: string) => boolean): boolean {
  if (item.rows[0]?.action || sentExchange(item)) return false;
  const peer = peerLine(message);
  if (peer?.delivery !== "ask_bot" || !peer.botId || peer.botId !== item.withBotId) return false;
  return item.target.kind === "group" && hasGroup(item.target.groupId);
}

export function foldedPreview(item: Pick<ExchangeItem, "folded">, limit = 140): string | undefined {
  const message = item.folded.at(-1);
  const body = message ? peerLine(message)?.body : undefined;
  const line = body?.split("\n").map((part) => part.trim()).find(Boolean);
  if (!line) return undefined;
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export function quietTranscriptItemShown(item: TranscriptItem, showToolCalls: boolean): boolean {
  if (item.kind === "run") return showToolCalls;
  if (item.kind !== "message") return true;
  const message = item.message;
  if (message.kind === "digest" || message.kind === "screen") return showToolCalls;
  return message.kind !== "activity" || showToolCalls || Boolean(message.comm || message.threadRef || message.cloudTask)
    || isStatusActivity(message) || Boolean(message.tool && failedTurnCause(message.tool.name) !== null);
}

export function carriesOnByItself(message: Message): boolean {
  const pickup = message.tool?.pickup;
  return message.tool?.ok === true && (pickup === "watch" || pickup === "restart") && isRecoveryActivity(message);
}

function failureRow(message: Message): boolean {
  const tool = message.tool;
  return message.kind === "activity" && tool?.ok === false && failedTurnCause(tool.name) !== null && !tool.pickup;
}

export function needsPerson(message: Message): boolean {
  const tool = message.tool;
  if (!tool || !failureRow(message)) return false;
  const raw = tool.detail ?? failedTurnCause(tool.name) ?? "";
  return Boolean(tool.setup || tool.claudeUpdate || tool.quota || tool.place)
    || isProviderSafetyBlock(raw) || MAC_PERMISSION.test(raw);
}

export function turnFailure(message: Message): boolean {
  return failureRow(message) && !needsPerson(message);
}

function lastAt(item: QuietTranscriptItem): number {
  return item.kind === "message" ? item.message.at : item.messages.at(-1)?.at ?? Number.NEGATIVE_INFINITY;
}

function firstAt(item: QuietTranscriptItem): number {
  return item.kind === "message" ? item.message.at : item.messages[0]?.at ?? Number.NEGATIVE_INFINITY;
}

function takeFailures(
  folded: Array<QuietTranscriptItem>,
  renders: (item: TranscriptItem) => boolean,
): { messages: Message[]; since: number } {
  const taken: number[] = [];
  let since: number | undefined;
  let earliest = Number.NEGATIVE_INFINITY;
  for (let index = folded.length - 1; index >= 0; index -= 1) {
    const candidate = folded[index]!;
    earliest = firstAt(candidate);
    if (candidate.kind === "message" && needsPerson(candidate.message)) return { messages: [], since: Number.NEGATIVE_INFINITY };
    if (candidate.kind === "message" && turnFailure(candidate.message)) {
      taken.push(index);
      continue;
    }
    const quiet = candidate.kind === "message"
      ? candidate.message.kind === "digest" || !renders(candidate)
      : candidate.kind === "run" && !renders(candidate);
    if (!quiet) {
      since = lastAt(candidate);
      break;
    }
  }
  const messages: Message[] = [];
  for (const index of taken) {
    const [item] = folded.splice(index, 1);
    if (item?.kind === "message") messages.unshift(item.message);
  }
  return { messages, since: since ?? earliest };
}

export function foldedRuns<R extends { id: string; startedAt: number }>(item: Pick<RecoveredItem, "since" | "recovery">, runs: readonly R[]): R[] {
  return runs.filter((run) => run.startedAt >= item.since && run.startedAt < item.recovery.at);
}

export function foldExchanges<T extends TranscriptItem>(
  items: readonly T[],
  { renders = () => true, hasGroup = () => false }: {
    renders?: (item: TranscriptItem) => boolean;
    hasGroup?: (groupId: string) => boolean;
  } = {},
): Array<T | ExchangeItem | RecoveredItem> {
  const folded: Array<T | ExchangeItem | RecoveredItem> = [];
  for (const item of items) {
    if (item.kind === "message" && carriesOnByItself(item.message)) {
      const { messages: failures, since } = takeFailures(folded, renders);
      if (failures.length) {
        folded.push({ kind: "recovered", id: `recovered:${item.message.id}`, recovery: item.message, messages: [...failures, item.message], folded: failures, since });
        continue;
      }
    }
    const last = lastRendered(folded, renders);
    if (item.kind === "message" && last?.kind === "exchange" && isPeerMessageOf(last, item.message, hasGroup)) {
      last.messages.push(item.message);
      last.folded.push(item.message);
      continue;
    }
    const row = item.kind === "message" ? exchangeRow(item.message) : null;
    if (!row) {
      folded.push(item);
      continue;
    }
    if (last?.kind === "exchange") {
      const prior = last.rows.at(-1)!;
      const sameRun = localDay(prior.message.at) === localDay(row.message.at)
        && prior.message.turnId === row.message.turnId
        && row.message.at >= prior.message.at;
      const sameFailure = row.action === "failed" && prior.action === "failed"
        && last.withBotId === row.withBotId && sameRun
        && prior.message.tool?.name === row.message.tool?.name;
      const sameExchange = !row.action && !prior.action && last.withBotId === row.withBotId && sameRun
        && (last.rows.every(previous => sameTarget(previous, row))
          || (row.direction === "to" && last.folded.length === 0 && last.rows.every(previous => previous.direction === "to")))
        && prior.message.from?.botId === row.message.from?.botId;
      if (sameFailure || sameExchange) {
        if (!last.rows.some(previous => previous.message.id === row.message.id)) {
          last.messages.push(row.message);
          last.rows.push(row);
        }
        continue;
      }
    }
    folded.push({
      kind: "exchange",
      id: `exchange:${row.message.id}`,
      withBotId: row.withBotId,
      target: row.target,
      messages: [row.message],
      rows: [row],
      folded: [],
    });
  }
  return folded;
}

export function failedExchange(item: Pick<ExchangeItem, "rows">): boolean {
  return item.rows[0]?.action === "failed";
}

export function sentExchange(item: Pick<ExchangeItem, "rows">): boolean {
  return item.rows.every(row => !row.action && row.direction === "to");
}

export function expandedExchange(item: Pick<ExchangeItem, "rows">): boolean {
  return item.rows.length > 1 && (failedExchange(item) || sentExchange(item));
}

export type ExchangeWording = { key: "chat.exchange.messaged" | "chat.exchange.messageFrom" | "chat.exchange.messagesWith"; count: number };

export function exchangeWording(item: Pick<ExchangeItem, "rows">): ExchangeWording {
  const count = item.rows.length;
  if (sentExchange(item)) return { key: "chat.exchange.messaged", count };
  if (count > 1) return { key: "chat.exchange.messagesWith", count };
  return { key: item.rows[0]!.direction === "to" ? "chat.exchange.messaged" : "chat.exchange.messageFrom", count };
}

export type ExchangeState = "Queued" | "Working" | "Done" | "Needs you" | "Failed" | "Stopped";

export interface ExchangeSummary {
  gist: string | null;
  state: ExchangeState;
  record?: WireExchange;
}

const RECORD_STATES = {
  queued: "Queued", running: "Working", waiting: "Working", "needs-you": "Needs you",
  completed: "Done", failed: "Failed", cancelled: "Stopped",
} as const satisfies Record<WireExchange["status"], ExchangeState>;

function gistOf(text: string | undefined): string | null {
  const line = (text ?? "").replace(/^(?:@\S+\s+)+/, "").replace(/\s+/g, " ").trim();
  return line ? (line.length > 90 ? `${line.slice(0, 89)}…` : line) : null;
}

export function exchangeRecord(item: Pick<ExchangeItem, "messages">): WireExchange | undefined {
  return item.messages.find((message) => message.exchange)?.exchange;
}

export function recordSummary(record: WireExchange): ExchangeSummary {
  const state: ExchangeState = record.status === "completed" && !record.reply ? "Working" : RECORD_STATES[record.status];
  return { gist: gistOf(record.request), state, record };
}

export function exchangeSummary(item: Pick<ExchangeItem, "messages" | "rows">, thread: readonly Message[] | null, working: boolean): ExchangeSummary | null {
  const record = exchangeRecord(item);
  if (record) return recordSummary(record);
  return thread ? exchangeGist(item, thread, working) : null;
}

export function exchangeGist(item: Pick<ExchangeItem, "messages" | "rows">, thread: readonly Message[], working: boolean): ExchangeSummary {
  const first = item.messages[0];
  const start = first ? thread.findIndex((message) => message.id === first.id) : -1;
  const after = start >= 0 ? thread.slice(start) : [];
  const request = after.find((message) => message.roomRequest?.phase === "request");
  const id = request?.roomRequest?.id;
  const line = (request?.text ?? "").replace(/^(?:@\S+\s+)+/, "").replace(/\s+/g, " ").trim();
  const gist = line ? (line.length > 90 ? `${line.slice(0, 89)}…` : line) : null;
  const lead = item.rows[0];
  const answered = after.some((message) => (id && message.roomRequest?.id === id && message.roomRequest.phase !== "request")
    || message.roomRequest?.phase === "result"
    || (lead?.direction === "to" && message.comm?.direction === "from" && message.comm.withBotId === lead.withBotId));
  const needsYou = after.some((message) => message.role === "bot" && Boolean(message.card) && !message.card?.answered && !message.card?.dismissed);
  const state: ExchangeState = answered ? "Done" : needsYou ? "Needs you" : working ? "Working" : "Queued";
  return { gist, state };
}

export function shownToPerson(message: Message): boolean {
  return !(message.role === "bot" && message.kind === "text" && message.roomRequest);
}
