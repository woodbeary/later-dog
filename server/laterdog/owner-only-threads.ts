import type { Message } from "../store.ts";

export interface OwnerOnlyThreadsDeps {
  lastMessage(threadId: string): Message | undefined;
  wholeThread(threadId: string): Message[];
  decide(threadId: string, thread: Message[]): boolean;
}

const KEPT = 5_000;

export function lastMessageKey(last: Message | undefined): string {
  return last ? `${last.id}:${last.card?.answeredBy ? JSON.stringify(last.card.answeredBy) : ""}` : "";
}

export class OwnerOnlyThreads {
  private readonly known = new Map<string, { last: string; owner: boolean }>();

  constructor(private readonly deps: OwnerOnlyThreadsDeps) {}

  ownerOnly(threadId: string): boolean {
    const last = lastMessageKey(this.deps.lastMessage(threadId));
    const cached = this.known.get(threadId);
    if (cached && cached.last === last) return cached.owner;
    const thread = this.deps.wholeThread(threadId);
    const owner = this.deps.decide(threadId, thread);
    if (this.known.size > KEPT) this.known.clear();
    this.known.set(threadId, { last: lastMessageKey(thread.at(-1)), owner });
    return owner;
  }

  clear(): void {
    this.known.clear();
  }
}
