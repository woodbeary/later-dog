import type { RoomHandoff } from "../room-handoffs.ts";
import { backNotGiven } from "./handoff-results.ts";

export interface OpenHandoff {
  id: string;
  to: string;
  what: string;
  state: RoomHandoff["status"];
  resultWaiting: boolean;
}

const ENDED: ReadonlySet<RoomHandoff["status"]> = new Set(["completed", "failed", "cancelled"]);
const WHAT_MAX = 140;

function oneLine(text: string): string {
  const line = text.split("\n").map(part => part.trim()).find(Boolean) ?? "";
  return line.length > WHAT_MAX ? `${line.slice(0, WHAT_MAX - 1)}…` : line;
}

export function openHandoffs(nodes: Iterable<RoomHandoff>, botId: string, threadId: string): OpenHandoff[] {
  const all = [...nodes];
  const senders = new Map(all.filter(n => n.botId === botId && n.threadId === threadId).map(n => [n.id, n]));
  const open: OpenHandoff[] = [];
  for (const n of [...all].sort((a, b) => a.createdAt - b.createdAt)) {
    const sender = n.parentId ? senders.get(n.parentId) : undefined;
    if (!sender) continue;
    const resultWaiting = n.reply !== "none" && !ENDED.has(sender.status) && backNotGiven(n);
    if (ENDED.has(n.status) && !resultWaiting) continue;
    open.push({ id: n.id, to: n.botId, what: oneLine(n.text), state: n.status, resultWaiting });
  }
  return open;
}
