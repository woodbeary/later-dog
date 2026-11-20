import type { Message } from "../store.ts";

export type RewindAction = "hold" | "resend" | "send";

export const REWIND_ACTIONS: readonly RewindAction[] = ["hold", "resend", "send"];

export interface BranchVersion {
  index: number;
  count: number;
  ids: string[];
}

export interface LeftInPlace {
  files: Array<{ path: string; change: string }>;
  moreFiles: number;
  commands: number;
  actions: number;
}

const FILES_SHOWN = 20;

const parentOf = (message: Pick<Message, "parentId">): string | null => message.parentId ?? null;

export const isPersonText = (message: Pick<Message, "role" | "kind">): boolean => message.role === "user" && message.kind === "text";

export function rewindAction(value: unknown): RewindAction | null {
  return typeof value === "string" && (REWIND_ACTIONS as readonly string[]).includes(value) ? value as RewindAction : null;
}

export function pathTo(messages: readonly Message[], leafId: string | null): Message[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const path: Message[] = [];
  const seen = new Set<string>();
  let cur = leafId ? byId.get(leafId) : undefined;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

export function versionOf(messages: readonly Message[], message: Pick<Message, "id" | "parentId">): BranchVersion {
  const siblings = messages.filter((candidate) => isPersonText(candidate) && parentOf(candidate) === parentOf(message))
    .sort((a, b) => a.at - b.at);
  const ids = siblings.map((sibling) => sibling.id);
  return { index: ids.indexOf(message.id) + 1, count: ids.length, ids };
}

export function branchVersions(messages: readonly Message[], activeLeafId: string | null): Record<string, BranchVersion> {
  const forks = new Map<string | null, Message[]>();
  for (const message of messages) {
    if (!isPersonText(message)) continue;
    const parent = parentOf(message);
    forks.set(parent, [...(forks.get(parent) ?? []), message]);
  }
  const versions: Record<string, BranchVersion> = {};
  for (const message of pathTo(messages, activeLeafId)) {
    if (!isPersonText(message)) continue;
    const siblings = forks.get(parentOf(message));
    if (!siblings || siblings.length < 2) continue;
    const ids = [...siblings].sort((a, b) => a.at - b.at).map((sibling) => sibling.id);
    for (const id of ids) versions[id] = { index: ids.indexOf(id) + 1, count: ids.length, ids };
  }
  return versions;
}

export function leftInPlace(dropped: readonly Message[]): LeftInPlace {
  const files = new Map<string, string>();
  let commands = 0;
  let actions = 0;
  for (const message of dropped) {
    for (const file of message.results?.files ?? []) files.set(file.path, file.change);
    commands += message.results?.commands ?? 0;
    if (message.kind === "activity" && message.tool && !message.tool.setup && !message.tool.statusLine) actions += 1;
  }
  const all = [...files].map(([path, change]) => ({ path, change }));
  return { files: all.slice(0, FILES_SHOWN), moreFiles: Math.max(0, all.length - FILES_SHOWN), commands, actions };
}

export function droppedAfter(activePath: readonly Message[], target: Pick<Message, "id">): Message[] {
  const at = activePath.findIndex((message) => message.id === target.id);
  return at === -1 ? [] : activePath.slice(at);
}
