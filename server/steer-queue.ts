
import { newId } from "./contracts.ts";
import { chatFollowups, saveChatFollowup, settleChatFollowups } from "./message-db.ts";
import { drainCoalesceHead } from "./admission.ts";
import type { BotQueuedMessages, ResolvedSender, SteerQueueReason } from "../shared/wire.ts";
import type { BotRecord, Message } from "./store.ts";
import type { UsageTrigger } from "./usage-ledger.ts";

export interface SteerStore {
  bot(id: string): BotRecord | null;
  projectBotForTask?(botId: string, threadId: string): BotRecord | null;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
}

interface QueueEntry {
  botId: string;
  items: Array<{
    messageId: string;
    text: string;
    prompt: string;
    replyToId?: string;
    sendId?: string;
    reason?: SteerQueueReason;
    unattended?: boolean;
    peerAsk?: Message["peerAsk"];
    sender?: ResolvedSender;
    trigger?: UsageTrigger;
    queuedAt: number;
    via?: "api" | "call";
  }>;
}

export type SteerQueueHead = Pick<QueueEntry["items"][number], "trigger" | "sender" | "peerAsk">;

const queues = new Map<string, QueueEntry>();

export interface HeldSteerQueue {
  botId: string;
  threadId: string;
  items: QueueEntry["items"];
}

export function restoreSteeredMessages(): void {
  queues.clear();
  for (const row of chatFollowups("bot")) {
    if (row.status !== "pending") continue;
    const entry = queues.get(row.threadId) ?? { botId: row.ownerId, items: [] };
    if (entry.botId !== row.ownerId) throw new Error("queued task belongs to another bot");
    const { via, ...payload } = row.payload;
    entry.items.push({
      ...payload,
      ...(via === "call" ? { via } : {}),
      messageId: row.id,
      prompt: row.payload.prompt ?? row.payload.text,
      queuedAt: row.payload.queuedAt ?? Date.now(),
    });
    queues.set(row.threadId, entry);
  }
}
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) {
    try { listener(); }
    catch { console.warn("steer-queue: change listener failed"); }
  }
};

export function queuedSteerSnapshot(ownsThread: (botId: string, threadId: string) => boolean): BotQueuedMessages {
  return Object.fromEntries([...queues]
    .filter(([threadId, entry]) => ownsThread(entry.botId, threadId))
    .map(([threadId, entry]) => [threadId, entry.items.map((item) => ({
      queueId: item.messageId, text: item.text,
      ...(item.sendId ? { sendId: item.sendId } : {}),
      ...(item.reason ? { reason: item.reason } : {}),
    }))]));
}

export function onSteeredQueueChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export interface QueuedSteer {
  id: string;
}

export function queueSteeredMessage(
  botId: string,
  threadId: string,
  text: string,
  options: { prompt?: string; replyToId?: string; sendId?: string; reason?: SteerQueueReason; unattended?: boolean; peerAsk?: Message["peerAsk"]; sender?: ResolvedSender; trigger?: UsageTrigger; via?: "api" | "call" } = {},
): QueuedSteer {
  const id = newId();
  const entry = queues.get(threadId) ?? { botId, items: [] };
  if (entry.botId !== botId) throw new Error("queued task belongs to another bot");
  const item = {
    messageId: id,
    text,
    prompt: options.prompt ?? text,
    replyToId: options.replyToId,
    sendId: options.sendId,
    reason: options.reason,
    unattended: options.unattended,
    peerAsk: options.peerAsk,
    sender: options.sender,
    trigger: options.trigger,
    queuedAt: Date.now(),
    via: options.via,
  };
  saveChatFollowup({ id, kind: "bot", ownerId: botId, threadId, payload: item });
  entry.items.push(item);
  queues.set(threadId, entry);
  changed();
  return { id };
}

export function queuedThreadPosition(botId: string, threadId: string): number | null {
  let position = 0;
  for (const [candidate, entry] of queues) {
    if (entry.botId !== botId || !entry.items.some((item) => item.reason === "capacity" || item.reason === "group-turn")) continue;
    position += 1;
    if (candidate === threadId) return position;
  }
  return null;
}

export function hasQueuedSteeredMessages(botId: string, threadId: string): boolean {
  const entry = queues.get(threadId);
  return entry?.botId === botId && entry.items.length > 0;
}

export function isSteeredMessageQueued(botId: string, threadId: string, queueId: string): boolean {
  const entry = queues.get(threadId);
  return entry?.botId === botId && entry.items.some((item) => item.messageId === queueId);
}

export function drainSteeredMessages(
  store: SteerStore,
  run: (
    botId: string,
    threadId: string,
    prompt: string,
    userMessage: Message,
    excludeIds: string[],
    unattended: boolean,
    head: SteerQueueHead,
  ) => void | Promise<void>,
  isBlocked?: (botId: string, threadId: string) => boolean,
): void {
  for (const [threadId, entry] of queues) {
    const bot = store.projectBotForTask
      ? store.projectBotForTask(entry.botId, threadId)
      : store.bot(entry.botId);
    if (!bot) {
      settleChatFollowups(entry.items.map((item) => item.messageId), "cancelled");
      queues.delete(threadId);
      changed();
      continue;
    }
    if (bot.busy || isBlocked?.(entry.botId, threadId)) continue;
    const group = drainCoalesceHead(entry.items, coalesceIdentity, (item) => item.queuedAt);
    const ids = group.map((item) => item.messageId);
    settleChatFollowups(ids, "dispatching");
    const rest = entry.items.slice(group.length);
    if (rest.length > 0) queues.set(threadId, { botId: entry.botId, items: rest });
    else queues.delete(threadId);
    changed();
    const appended: Message[] = [];
    for (const item of group) {
      appended.push(
        store.appendMessage(threadId, {
          role: "user",
          kind: "text",
          text: item.text,
          replyToId: item.replyToId,
          sendId: item.sendId,
          queueId: item.messageId,
          peerAsk: item.peerAsk,
          sender: item.sender,
          ...(item.via ? { via: item.via } : {}),
        }),
      );
    }
    const last = appended.at(-1);
    if (!last) continue;
    const prompt = group.map((item) => item.prompt).join("\n\n");
    const running = run(
      entry.botId,
      threadId,
      prompt,
      last,
      appended.map((message) => message.id),
      group.some((item) => item.unattended === true),
      { trigger: group[0].trigger, sender: group[0].sender, peerAsk: group[0].peerAsk },
    );
    void Promise.resolve(running).then(
      () => settleChatFollowups(ids, null),
      () => settleChatFollowups(ids, "interrupted"),
    ).catch((error) => console.warn("steer-queue: could not settle durable follow-up", error));
  }
}

function coalesceIdentity(item: QueueEntry["items"][number]): string {
  if (item.peerAsk) return `peer:${item.peerAsk.botId}:${item.unattended === true ? "unattended" : "attended"}`;
  if (item.unattended === true) return "unattended";
  if (item.sender) return `person:${item.sender.id ?? item.sender.name}`;
  return "person:local";
}

export function queuedSteeredMessage(
  botId: string,
  threadId: string,
  sendId: string,
): { id: string; text: string; replyToId?: string; reason?: SteerQueueReason } | null {
  const entry = queues.get(threadId);
  if (!entry || entry.botId !== botId) return null;
  const item = entry.items.find((candidate) => candidate.sendId === sendId);
  return item ? { id: item.messageId, text: item.text, replyToId: item.replyToId, ...(item.reason ? { reason: item.reason } : {}) } : null;
}

export function cancelSteeredMessage(botId: string, messageId: string, expectedThreadId?: string): boolean {
  for (const [threadId, entry] of queues) {
    if (entry.botId !== botId || (expectedThreadId !== undefined && threadId !== expectedThreadId)) continue;
    const items = entry.items.filter((item) => item.messageId !== messageId);
    if (items.length === entry.items.length) continue;
    settleChatFollowups([messageId], "cancelled");
    if (items.length === 0) queues.delete(threadId);
    else queues.set(threadId, { botId: entry.botId, items });
    changed();
    return true;
  }
  return false;
}

export function holdSteeredQueue(botId: string, threadId: string, queueId: string): HeldSteerQueue | null {
  const entry = queues.get(threadId);
  if (!entry || entry.botId !== botId || !entry.items.some((item) => item.messageId === queueId)) return null;
  queues.delete(threadId);
  changed();
  return { botId, threadId, items: entry.items };
}

export function restoreHeldSteeredQueue(held: HeldSteerQueue): void {
  const existing = queues.get(held.threadId);
  if (existing && existing.botId !== held.botId) throw new Error("queued task belongs to another bot");
  queues.set(held.threadId, {
    botId: held.botId,
    items: existing ? [...held.items, ...existing.items] : held.items,
  });
  changed();
}

export function settleHeldSteeredQueue(held: HeldSteerQueue): void {
  settleChatFollowups(held.items.map((item) => item.messageId), null);
}

export function _queuedCount(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}
