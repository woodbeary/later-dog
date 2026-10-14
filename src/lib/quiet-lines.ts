import type { Message } from "@/state/store";
import type { DogColor } from "./mascot";
import type { TranscriptItem } from "./activity-runs";
import { peerLine } from "./peer-message";
import { localDay } from "./transcript-derivations";

export type ExchangeDirection = "to" | "from";

export type ExchangeTarget =
  | { kind: "group"; groupId: string }
  | { kind: "thread"; botId: string; threadId: string; title: string };

export interface ExchangeRow {
  message: Message;
  withBotId: string;
  withName: string;
  withColor: DogColor;
  direction: ExchangeDirection;
  action?: "opened";
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

export type QuietTranscriptItem = TranscriptItem | ExchangeItem;

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
  if (ref && tool.name.startsWith("Opened thread #")) {
    if (tool.ok !== true || message.role !== "bot") return null;
    return {
      message, withBotId: ref.botId, withName: teammateName(tool.name) ?? "", withColor: "blue", direction: "to", action: "opened",
      target: { kind: "thread", botId: ref.botId, threadId: ref.threadId, title: ref.title },
    };
  }
  const comm = message.comm;
  if (comm) {
    const direction = comm.direction
      ?? (LEGACY_TO.test(tool.name) ? "to" : LEGACY_FROM.test(tool.name) ? "from" : undefined);
    return direction
      ? { message, withBotId: comm.withBotId, withName: comm.withName, withColor: comm.withColor, direction, target: { kind: "group", groupId: comm.groupId } }
      : null;
  }
  const name = ref ? teammateName(tool.name) : undefined;
  if (ref && name) {
    return {
      message, withBotId: ref.botId, withName: name, withColor: "blue", direction: "to",
      target: { kind: "thread", botId: ref.botId, threadId: ref.threadId, title: ref.title },
    };
  }
  return null;
}

function sameTarget(a: ExchangeTarget, b: ExchangeTarget): boolean {
  return a.kind === "group" ? b.kind === "group" && a.groupId === b.groupId : b.kind === "thread" && a.botId === b.botId;
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
    if (candidate.kind === "exchange" || candidate.kind === "turn" || renders(candidate)) return candidate;
  }
  return undefined;
}

function isPeerMessageOf(item: ExchangeItem, message: Message, hasGroup: (groupId: string) => boolean): boolean {
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

export function foldExchanges<T extends TranscriptItem>(
  items: readonly T[],
  { renders = () => true, hasGroup = () => false, openedOnly = false }: {
    renders?: (item: TranscriptItem) => boolean;
    hasGroup?: (groupId: string) => boolean;
    openedOnly?: boolean;
  } = {},
): Array<T | ExchangeItem> {
  const folded: Array<T | ExchangeItem> = [];
  for (const item of items) {
    const last = lastRendered(folded, renders);
    if (item.kind === "message" && last?.kind === "exchange" && isPeerMessageOf(last, item.message, hasGroup)) {
      last.messages.push(item.message);
      last.folded.push(item.message);
      continue;
    }
    const candidate = item.kind === "message" ? exchangeRow(item.message) : null;
    const row = openedOnly && candidate?.action !== "opened" ? null : candidate;
    if (!row) {
      folded.push(item);
      continue;
    }
    if (last?.kind === "exchange") {
      const prior = last.rows.at(-1)!;
      const opened = row.action === "opened";
      const sameOpeningRun = opened && prior.action === "opened"
        && localDay(prior.message.at) === localDay(row.message.at)
        && prior.message.turnId === row.message.turnId
        && row.message.at >= prior.message.at
        && (Boolean(row.message.turnId) || row.message.at - last.rows[0]!.message.at <= 60_000)
        && prior.message.from?.botId === row.message.from?.botId;
      const sameExchange = !opened && prior.action !== "opened" && last.withBotId === row.withBotId && sameTarget(last.target, row.target);
      if (sameOpeningRun || sameExchange) {
        if (!opened || !last.rows.some(previous => previous.message.id === row.message.id)) {
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

export function openedExchange(item: Pick<ExchangeItem, "rows">): boolean {
  return item.rows[0]?.action === "opened";
}

export type ExchangeWording = { key: "chat.exchange.messaged" | "chat.exchange.messageFrom" | "chat.exchange.messagesWith" | "chat.threads.opened" | "chat.threads.openedOne"; count: number };

export function exchangeWording(item: Pick<ExchangeItem, "rows">): ExchangeWording {
  const count = item.rows.length;
  if (openedExchange(item)) return { key: count === 1 ? "chat.threads.openedOne" : "chat.threads.opened", count };
  if (count > 1) return { key: "chat.exchange.messagesWith", count };
  return { key: item.rows[0]!.direction === "to" ? "chat.exchange.messaged" : "chat.exchange.messageFrom", count };
}
