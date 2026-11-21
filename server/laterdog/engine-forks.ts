import { existsSync, readFileSync } from "node:fs";

import type { EngineForkPoint } from "../../shared/runtime-events.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { Message } from "../store.ts";

export interface EngineForkAnchor extends EngineForkPoint {
  instanceId: string;
  lastMessageId: string;
}

const ANCHORS_PER_THREAD = 64;
const THREADS_KEPT = 400;

function anchorOf(value: unknown): EngineForkAnchor | null {
  if (!value || typeof value !== "object") return null;
  const { instanceId, session, at, lastMessageId } = value as Record<string, unknown>;
  return [instanceId, session, at, lastMessageId].every((field) => typeof field === "string" && field.length > 0 && field.length <= 512)
    ? { instanceId, session, at, lastMessageId } as EngineForkAnchor
    : null;
}

export function forkSeesMessage(message: Pick<Message, "kind" | "text" | "digest" | "compaction" | "roomRequest">): boolean {
  if (message.kind === "digest") return false;
  return Boolean((message.kind === "text" && message.text) || message.kind === "compaction" || message.roomRequest?.phase === "result");
}

export function forkPointFor(anchors: readonly EngineForkAnchor[], instanceId: string, keptPath: readonly Message[]): EngineForkPoint | undefined {
  for (let index = keptPath.length - 1; index >= 0; index--) {
    const message = keptPath[index]!;
    const anchor = anchors.findLast((candidate) => candidate.instanceId === instanceId && candidate.lastMessageId === message.id);
    if (anchor) return { session: anchor.session, at: anchor.at };
    if (forkSeesMessage(message)) return undefined;
  }
  return undefined;
}

export class EngineForks {
  private readonly threads = new Map<string, EngineForkAnchor[]>();
  private readonly file: string | undefined;

  constructor(file?: string) {
    this.file = file;
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const [threadId, list] of Object.entries(raw ?? {})) {
        const anchors = Array.isArray(list) ? list.map(anchorOf).filter((anchor): anchor is EngineForkAnchor => anchor !== null) : [];
        if (anchors.length) this.threads.set(threadId, anchors.slice(-ANCHORS_PER_THREAD));
      }
    } catch {}
  }

  record(threadId: string, instanceId: string, point: EngineForkPoint, activePath: readonly Message[]): EngineForkAnchor | null {
    const last = activePath.findLast(forkSeesMessage);
    const anchor = last ? anchorOf({ instanceId, session: point.session, at: point.at, lastMessageId: last.id }) : null;
    if (!anchor) return null;
    const list = (this.threads.get(threadId) ?? []).filter((kept) => !(kept.instanceId === instanceId && kept.lastMessageId === anchor.lastMessageId));
    list.push(anchor);
    this.threads.delete(threadId);
    this.threads.set(threadId, list.slice(-ANCHORS_PER_THREAD));
    while (this.threads.size > THREADS_KEPT) this.threads.delete(this.threads.keys().next().value!);
    this.save();
    return anchor;
  }

  pointFor(threadId: string, instanceId: string, keptPath: readonly Message[]): EngineForkPoint | undefined {
    return forkPointFor(this.threads.get(threadId) ?? [], instanceId, keptPath);
  }

  forget(threadId: string): void {
    if (this.threads.delete(threadId)) this.save();
  }

  private save(): void {
    if (!this.file) return;
    try {
      writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(this.threads)), { mode: 0o600 });
    } catch {}
  }
}
