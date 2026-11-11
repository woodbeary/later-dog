type Linked = { id: string; parentId?: string | null; at: number };

export function descendsFrom(messages: readonly Linked[], messageId: string | null, ancestorId: string): boolean {
  const parents = new Map(messages.map((message) => [message.id, message.parentId ?? null]));
  for (let current = messageId; current !== null; current = parents.get(current) ?? null) {
    if (current === ancestorId) return true;
  }
  return false;
}

export function newestTip(messages: readonly Linked[], fromId: string | null): string | null {
  if (fromId === null) return null;
  const newestChild = new Map<string, Linked>();
  for (const message of messages) {
    if (!message.parentId) continue;
    const held = newestChild.get(message.parentId);
    if (!held || message.at >= held.at) newestChild.set(message.parentId, message);
  }
  let tip = fromId;
  for (let child = newestChild.get(tip); child; child = newestChild.get(tip)) tip = child.id;
  return tip;
}

export const EDGE_LINE_PREFIX = "desk-";

export function afterShownLeaf<T extends Linked>(messages: readonly Linked[], leafId: string | null, line: T): T {
  const parent = line.parentId ?? null;
  if (!line.id.startsWith(EDGE_LINE_PREFIX) || parent?.startsWith(EDGE_LINE_PREFIX) || leafId === null || parent === leafId) return line;
  const behindTheLeaf = parent === null || descendsFrom(messages, leafId, parent);
  return behindTheLeaf ? { ...line, parentId: leafId } : line;
}
