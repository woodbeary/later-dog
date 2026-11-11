import { OPTIMISTIC_PREFIX } from "@/lib/dog-status";
import { afterShownLeaf, descendsFrom } from "@/lib/leaf-follow";
import type { Message } from "./store";

interface SavedChat {
  threadId: string;
  messages: Message[];
  hasMore?: boolean;
  activeLeafId?: string | null;
}

function shownLeaf(shown: SavedChat): string | null {
  const byId = new Map(shown.messages.map((message) => [message.id, message]));
  let leaf = shown.activeLeafId ?? null;
  while (leaf?.startsWith(OPTIMISTIC_PREFIX)) leaf = byId.get(leaf)?.parentId ?? null;
  return leaf;
}

export function withShownLines<T extends SavedChat>(shown: T | undefined, saved: T, shownIsLive: boolean): T {
  if (!shown || shown.threadId !== saved.threadId) return saved;
  const copied = new Set(saved.messages.map((message) => message.id));
  const fromHome = shown.messages.filter((message) => !message.id.startsWith(OPTIMISTIC_PREFIX));
  const held = new Map(fromHome.map((message) => [message.id, message]));
  const followers = new Map<string | null, Message[]>();
  let anchor: string | null = null;
  for (const message of fromHome) {
    if (copied.has(message.id)) anchor = message.id;
    else followers.set(anchor, [...(followers.get(anchor) ?? []), message]);
  }
  if (followers.size === 0 && !shownIsLive) return saved;

  const leading = followers.get(null) ?? [];
  const body = saved.messages.flatMap((message) => [shownIsLive ? held.get(message.id) ?? message : message, ...(followers.get(message.id) ?? [])]);
  const leadingIsOlder = anchor !== null || saved.messages.length === 0 || leading.length === 0 || leading[0]!.at <= saved.messages[0]!.at;
  let messages = leadingIsOlder ? [...leading, ...body] : [...body, ...leading];

  const ownLeaf = shownLeaf(shown);
  let leaf = saved.activeLeafId ?? null;
  if (ownLeaf !== null && held.has(ownLeaf)) {
    let tip = ownLeaf;
    for (const unseen of saved.messages.filter((message) => !held.has(message.id))) {
      const line: Message = afterShownLeaf(messages, tip, unseen);
      if (line !== unseen) messages = messages.map((message) => (message.id === line.id ? line : message));
      if (line.parentId === tip || descendsFrom(messages, line.parentId ?? null, tip)) tip = line.id;
    }
    leaf = tip;
  }
  const leafless = saved.activeLeafId === undefined && shown.activeLeafId === undefined;
  return {
    ...saved,
    messages,
    hasMore: messages[0] !== undefined && messages[0].id === saved.messages[0]?.id ? saved.hasMore : shown.hasMore,
    ...(leafless ? {} : { activeLeafId: leaf }),
  };
}
