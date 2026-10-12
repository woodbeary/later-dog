
import { sectionKey, type BotRecord, type GroupRecord, type Message, type Store } from "./store.ts";

export interface CommsBus {
  store: Store;
  broadcast: (payload: Record<string, unknown>) => void;
  threadSlotFree?: (botId: string) => boolean;
  canAdmitDirectTurn?: (botId: string, threadId: string) => boolean;
}

export function getOrCreateChannel(
  store: Store,
  from: BotRecord,
  target: BotRecord,
  originatingGroup?: GroupRecord,
): GroupRecord {
  if (
    originatingGroup &&
    !originatingGroup.dm &&
    originatingGroup.memberIds.includes(from.id) &&
    originatingGroup.memberIds.includes(target.id)
  ) {
    return originatingGroup;
  }
  const existing = store.dmGroup(from.id, target.id);
  if (existing) {
    if (sectionKey(existing.section) !== sectionKey(from.section)) {
      return store.patchGroup(existing.id, { section: from.section }) ?? existing;
    }
    return existing;
  }
  return store.createGroup(`${from.name} ⇄ ${target.name}`, [from.id, target.id], true, from.section);
}

function markMirrored(bus: CommsBus, channel: GroupRecord, notify: boolean | undefined): void {
  const patch: Partial<Pick<GroupRecord, "unread">> = {};
  if (notify ?? !channel.dm) patch.unread = true;
  bus.store.patchGroup(channel.id, patch);
}

export function mirrorExchange(
  bus: CommsBus,
  from: BotRecord,
  target: BotRecord,
  message: string,
  channel: GroupRecord | undefined,
  sourceThreadId = from.threadId,
  notify?: boolean,
): void {
  const note = (threadId: string, m: Omit<Message, "id" | "at">) => {
    bus.store.appendMessage(threadId, m);
    return message;
  };
  if (channel) {
    note(channel.threadId, {
      role: "bot",
      kind: "text",
      text: message,
      from: { botId: from.id, name: from.name, color: from.color },
    });
  }
  note(sourceThreadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Messaged @${target.name}` },
    comm: channel
      ? { groupId: channel.id, withBotId: target.id, withName: target.name, withColor: target.color }
      : undefined,
  });
  note(target.threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Message from @${from.name}` },
    comm: channel
      ? { groupId: channel.id, withBotId: from.id, withName: from.name, withColor: from.color }
      : undefined,
  });
  if (channel) markMirrored(bus, channel, notify);
}

export function mirrorReply(
  bus: CommsBus,
  target: BotRecord,
  reply: string,
  channel: GroupRecord | undefined,
  notify?: boolean,
): void {
  if (!channel || !reply.trim()) return;
  bus.store.appendMessage(channel.threadId, {
    role: "bot",
    kind: "text",
    text: reply,
    from: { botId: target.id, name: target.name, color: target.color },
  });
  markMirrored(bus, channel, notify);
}

export function mirrorActivity(
  bus: CommsBus,
  from: BotRecord,
  channel: GroupRecord | undefined,
  name: string,
  ok: boolean,
  notify?: boolean,
): void {
  if (!channel) return;
  bus.store.appendMessage(channel.threadId, {
    role: "bot",
    kind: "activity",
    tool: { name, ok },
    from: { botId: from.id, name: from.name, color: from.color },
  });
  markMirrored(bus, channel, notify);
}
