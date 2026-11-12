import type { ExchangeStatus, WireExchange } from "../../shared/room-exchange.ts";
import type { WireMessage } from "../../shared/wire.ts";
import { awaitsReply, type RoomHandoff } from "../room-handoffs.ts";

export const EXCHANGE_TEXT_MAX = 4_000;

export interface ExchangeLookup {
  node(id: string): RoomHandoff | undefined;
  children(id: string): RoomHandoff[];
  name(botId: string): string | undefined;
  redact(text: string): string;
}

const OPEN = new Set<RoomHandoff["status"]>(["queued", "running", "waiting", "resume", "needs-you"]);

const clip = (text: string): string => text.length > EXCHANGE_TEXT_MAX ? `${text.slice(0, EXCHANGE_TEXT_MAX - 1)}…` : text;

function statusOf(node: RoomHandoff): ExchangeStatus | undefined {
  switch (node.status) {
    case "source": return undefined;
    case "resume": return "running";
    case "completed": return node.result.trim() || !awaitsReply(node) ? "completed" : "running";
    default: return node.status;
  }
}

export function roomExchange(node: RoomHandoff, lookup: ExchangeLookup): WireExchange | undefined {
  const status = statusOf(node);
  const to = lookup.name(node.botId);
  const root = lookup.node(node.rootId);
  const owner = root ? lookup.name(root.botId) : undefined;
  if (!status || !to || !root || !owner) return undefined;
  const parent = node.parentId ? lookup.node(node.parentId) : undefined;
  const from = parent ? lookup.name(parent.botId) : undefined;
  const request = clip(lookup.redact(node.text.trim()));
  const reply = status === "completed" && node.result.trim() ? clip(lookup.redact(node.result.trim())) : undefined;
  const waitingOn = [...new Set(lookup.children(node.id).filter((child) => awaitsReply(child) && OPEN.has(child.status))
    .map((child) => lookup.name(child.botId)).filter((name): name is string => Boolean(name)))];
  return {
    id: node.id, status, to, request,
    owner: { dog: owner, person: Boolean(root.requestedBy) },
    ...(from ? { from } : {}),
    ...(node.parentId ? { parentId: node.parentId } : {}),
    ...(reply ? { reply } : {}),
    ...(node.endedBy ? { endedBy: node.endedBy } : {}),
    ...(waitingOn.length ? { waitingOn } : {}),
  };
}

export function exchangeIdOf(message: Pick<WireMessage, "roomRequest" | "handoffId">): string | undefined {
  return message.roomRequest?.id ?? message.handoffId;
}

export function withExchange<T extends WireMessage>(message: T, lookup: ExchangeLookup): T & { exchange?: WireExchange } {
  const id = exchangeIdOf(message);
  const node = id ? lookup.node(id) : undefined;
  const exchange = node ? roomExchange(node, lookup) : undefined;
  return exchange ? { ...message, exchange } : message;
}

export function exchangeThreads(nodes: Iterable<RoomHandoff>, groupIds: ReadonlySet<string>, threadIds: ReadonlySet<string>,
  node: (id: string) => RoomHandoff | undefined): Map<string, Set<string>> {
  const touched = new Map<string, Set<string>>();
  const note = (threadId: string, id: string) => {
    const ids = touched.get(threadId) ?? new Set<string>();
    ids.add(id);
    touched.set(threadId, ids);
  };
  for (const changed of nodes) {
    if (!(changed.groupId ? groupIds.has(changed.groupId) : threadIds.has(changed.threadId)) || !changed.parentId) continue;
    note(changed.threadId, changed.id);
    const parent = node(changed.parentId);
    if (parent) note(parent.threadId, changed.id);
  }
  return touched;
}
