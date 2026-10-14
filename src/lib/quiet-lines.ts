import type { Message } from "@/state/store";
import type { TranscriptItem } from "./activity-runs";

export type ExchangeDirection = "to" | "from";

type Comm = NonNullable<Message["comm"]>;

export interface ExchangeRow {
  message: Message;
  comm: Comm;
  direction: ExchangeDirection;
}

export interface ExchangeItem {
  kind: "exchange";
  id: string;
  withBotId: string;
  groupId: string;
  messages: Message[];
  rows: ExchangeRow[];
}

export type QuietTranscriptItem = TranscriptItem | ExchangeItem;

const LEGACY_TO = /^Messaged @/;
const LEGACY_FROM = /^Message from @/;

export function exchangeRow(message: Message): ExchangeRow | null {
  const comm = message.comm;
  if (message.kind !== "activity" || !message.tool || !comm) return null;
  const direction = comm.direction
    ?? (LEGACY_TO.test(message.tool.name) ? "to" : LEGACY_FROM.test(message.tool.name) ? "from" : undefined);
  return direction ? { message, comm, direction } : null;
}

export function foldExchanges(
  items: readonly TranscriptItem[],
  renders: (item: TranscriptItem) => boolean = () => true,
): QuietTranscriptItem[] {
  const folded: QuietTranscriptItem[] = [];
  for (const item of items) {
    const row = item.kind === "message" ? exchangeRow(item.message) : null;
    if (!row) {
      folded.push(item);
      continue;
    }
    let last: QuietTranscriptItem | undefined;
    for (let index = folded.length - 1; index >= 0; index -= 1) {
      const candidate = folded[index]!;
      if (candidate.kind === "exchange" || candidate.kind === "turn" || renders(candidate)) {
        last = candidate;
        break;
      }
    }
    if (last?.kind === "exchange" && last.withBotId === row.comm.withBotId && last.groupId === row.comm.groupId) {
      last.messages.push(row.message);
      last.rows.push(row);
      continue;
    }
    folded.push({
      kind: "exchange",
      id: `exchange:${row.message.id}`,
      withBotId: row.comm.withBotId,
      groupId: row.comm.groupId,
      messages: [row.message],
      rows: [row],
    });
  }
  return folded;
}

export type ExchangeWording = { key: "chat.exchange.messaged" | "chat.exchange.messageFrom" | "chat.exchange.messagesWith"; count: number };

export function exchangeWording(item: Pick<ExchangeItem, "rows">): ExchangeWording {
  const count = item.rows.length;
  if (count > 1) return { key: "chat.exchange.messagesWith", count };
  return { key: item.rows[0]!.direction === "to" ? "chat.exchange.messaged" : "chat.exchange.messageFrom", count };
}
