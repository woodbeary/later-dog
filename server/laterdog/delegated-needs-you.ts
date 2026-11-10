import type { WireMessage } from "../../shared/wire.ts";
import type { RoomHandoff } from "../room-handoffs.ts";

type Need = NonNullable<WireMessage["needsYou"]>;

export function cardNeed(message: WireMessage): Pick<Need, "label" | "status"> | undefined {
  if (message.secureForm) return {
    label: message.secureForm.title,
    status: ["open", "sending"].includes(message.secureForm.status) ? "waiting" : message.secureForm.status === "filled" ? "answered" : "dismissed",
  };
  if (message.secret) return {
    label: message.secret.label,
    status: message.secret.provided ? "answered" : message.secret.dismissed || message.secret.superseded ? "dismissed" : "waiting",
  };
  const card = message.card;
  const device = card?.deviceApproval;
  const takeover = card?.takeoverRequest;
  if (!device && !takeover) return undefined;
  return {
    label: device ? `Approve ${device.service} sign-in` : takeover!.step,
    status: card?.dismissed || card?.expired ? "dismissed" : device
      ? device.status === "waiting" ? "waiting" : device.status === "approved" ? "answered" : "dismissed"
      : ["waiting", "in-control"].includes(takeover!.status) ? "waiting" : takeover!.status === "done" ? "answered" : "dismissed",
  };
}

export interface NeedsYouHost {
  messages(threadId: string): WireMessage[];
  append(threadId: string, need: Need): void;
  patch(threadId: string, messageId: string, need: Need): void;
  name(botId: string): string;
  allowed(child: RoomHandoff, parent: RoomHandoff): boolean;
  notify(parent: RoomHandoff, need: Need): void;
}

export function forwardNeedsYou(node: RoomHandoff, path: RoomHandoff[], host: NeedsYouHost): boolean {
  let waiting = false;
  for (const message of host.messages(node.threadId)) {
    const state = cardNeed(message);
    if (!state || message.at < (node.startedAt ?? node.createdAt) || (message.from && message.from.botId !== node.botId)) continue;
    waiting ||= state.status === "waiting";
    const need: Need = { botId: node.botId, botName: host.name(node.botId), threadId: node.threadId, messageId: message.id, ...state };
    for (let index = path.length - 2; index >= 0; index--) {
      const parent = path[index];
      const child = path[index + 1];
      if (!host.allowed(child, parent)) break;
      if (parent.threadId === node.threadId) continue;
      const existing = host.messages(parent.threadId).find(row => row.needsYou?.threadId === node.threadId && row.needsYou.messageId === message.id);
      if (existing) {
        if (existing.needsYou?.status !== need.status) host.patch(parent.threadId, existing.id, need);
      } else if (need.status === "waiting") {
        host.append(parent.threadId, need);
        host.notify(parent, need);
      }
    }
  }
  return waiting;
}
