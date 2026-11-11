import { rememberFailedComposerSend } from "@/lib/drafts";
import { HELD_NOT_SENT, heldAnswer, readHeldSends, sortHeldSends, writeHeldSends } from "@/lib/held-sends";
import {
  SEND_ATTEMPT_TIMEOUT_MS,
  browserStore,
  createOutbox,
  readOutbox,
  writeOutbox,
  type Outbox,
  type OutboxItem,
} from "@/lib/outbox";
import type { Action, ApiInit, Bot, Group } from "./store";

type Store = ReturnType<typeof browserStore>;

export interface SendOutboxDeps {
  request: (path: string, init: ApiInit) => Promise<any>;
  dispatch: (action: Action) => void;
  showError: (error: unknown, threadId: string) => void;
  store?: Store;
  after?: (ms: number, run: () => void) => () => void;
  now?: () => number;
}

export interface SendHooks {
  ready?: Promise<unknown>;
  onError?: () => void;
}

export interface SendOutbox {
  send(item: OutboxItem, hooks?: SendHooks): void;
  pending(bots: readonly Pick<Bot, "messages">[], groups: readonly Pick<Group, "messages">[], queues?: unknown): OutboxItem[];
  echoed(sendId: string): void;
  queued(queues: unknown): void;
  settleHeld(bots: readonly Pick<Bot, "messages">[], groups: readonly Pick<Group, "messages">[], queues?: unknown): Promise<void>;
  resume(): void;
  dispose(): void;
}

export class SendRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendRefusedError";
  }
}

const QUEUE_REASONS = new Set(["capacity", "group-turn"]);

function pathFor(item: OutboxItem): string {
  return item.target.kind === "bot"
    ? `/api/bots/${item.target.botId}/messages`
    : `/api/groups/${item.target.groupId}/messages`;
}

function payloadFor(item: OutboxItem): Record<string, unknown> {
  const base = { text: item.text, replyToId: item.replyToId, threadId: item.threadId || undefined, sendId: item.sendId };
  return item.target.kind === "bot" ? { ...base, deliver: item.target.deliver } : base;
}

export function sendIdsInQueues(queues: unknown): string[] {
  if (typeof queues !== "object" || queues === null) return [];
  return Object.values(queues as Record<string, unknown>).flatMap((entries) =>
    Array.isArray(entries)
      ? entries.flatMap((entry) => {
          const sendId = (entry as { sendId?: unknown } | null)?.sendId;
          return typeof sendId === "string" && sendId ? [sendId] : [];
        })
      : [],
  );
}

export function createSendOutbox(deps: SendOutboxDeps): SendOutbox {
  const store = "store" in deps ? deps.store : browserStore();
  const hooks = new Map<string, SendHooks>();
  const now = deps.now ?? Date.now;
  const landedSendIds = (bots: readonly Pick<Bot, "messages">[], groups: readonly Pick<Group, "messages">[], queues: unknown) => {
    const landed = new Set<string>(sendIdsInQueues(queues));
    for (const owner of [...bots, ...groups]) {
      for (const message of owner.messages ?? []) {
        if (message.sendId && !message.id.startsWith("optimistic-")) landed.add(message.sendId);
      }
    }
    return landed;
  };

  const settle = (item: OutboxItem, body: any) => {
    if (body?.message && typeof body.threadId === "string") {
      deps.dispatch({ type: "messageAdded", threadId: body.threadId, message: body.message });
    }
    if (body?.queued && typeof body.threadId === "string" && typeof body.queueId === "string") {
      deps.dispatch({ type: "optimisticMessageRemoved", threadId: body.threadId, sendId: item.sendId });
      deps.dispatch({
        type: "pendingQueued",
        threadId: body.threadId,
        queueId: body.queueId,
        text: item.text,
        reason: item.target.kind === "bot" && QUEUE_REASONS.has(body.reason) ? body.reason : undefined,
      });
      if (body.queueId === item.sendId && item.recovery) {
        writeHeldSends(store, [
          ...readHeldSends(store).filter((held) => held.sendId !== item.sendId),
          { sendId: item.sendId, threadId: body.threadId, draftId: item.recovery.draftId, text: item.recovery.text, requestText: item.text, replyToId: item.replyToId, at: now() },
        ]);
      }
    }
  };

  const outbox: Outbox = createOutbox({
    after: deps.after,
    save: (items) => writeOutbox(store, items),
    attempt: async (item) => {
      const ready = hooks.get(item.sendId)?.ready;
      if (ready) {
        try {
          await ready;
        } catch (error) {
          throw new SendRefusedError(error instanceof Error && error.message ? error.message : "This message was not sent.");
        }
        const kept = hooks.get(item.sendId);
        if (kept) hooks.set(item.sendId, { onError: kept.onError });
      }
      const body = await deps.request(pathFor(item), {
        method: "POST",
        body: JSON.stringify(payloadFor(item)),
        timeoutMs: SEND_ATTEMPT_TIMEOUT_MS,
        rideWake: false,
      });
      hooks.delete(item.sendId);
      settle(item, body);
    },
    onHeld: (item) => deps.dispatch({ type: "sendHeld", threadId: item.threadId, sendId: item.sendId }),
    onFinal: (item, error) => {
      const onError = hooks.get(item.sendId)?.onError;
      hooks.delete(item.sendId);
      deps.dispatch({ type: "optimisticMessageRemoved", threadId: item.threadId, sendId: item.sendId });
      deps.showError(error, item.threadId);
      if (onError) onError();
      else if (item.recovery) {
        rememberFailedComposerSend(item.recovery.draftId, {
          sendId: item.sendId,
          text: item.recovery.text,
          requestText: item.text,
          replyToId: item.replyToId,
          threadId: item.threadId,
        });
      }
    },
  });
  outbox.restore(readOutbox(store));

  const forget = (sendId: string) => {
    hooks.delete(sendId);
    outbox.acknowledge(sendId);
  };

  return {
    send(item, sendHooks) {
      sendHooks?.ready?.catch(() => {});
      if (sendHooks) hooks.set(item.sendId, sendHooks);
      outbox.enqueue(item);
    },
    pending(bots, groups, queues) {
      const landed = landedSendIds(bots, groups, queues);
      for (const item of outbox.items()) if (landed.has(item.sendId)) forget(item.sendId);
      return outbox.items();
    },
    echoed: forget,
    queued(queues) {
      const waiting = new Set(sendIdsInQueues(queues));
      for (const item of outbox.items()) {
        if (!waiting.has(item.sendId)) continue;
        deps.dispatch({ type: "optimisticMessageRemoved", threadId: item.threadId, sendId: item.sendId });
        forget(item.sendId);
      }
    },
    async settleHeld(bots, groups, queues) {
      const held = readHeldSends(store);
      if (held.length === 0) return;
      const landed = landedSendIds(bots, groups, queues);
      const waiting = held.filter((send) => !landed.has(send.sendId));
      if (waiting.length !== held.length) writeHeldSends(store, waiting);
      if (waiting.length === 0) return;
      const answer = await deps
        .request(`/api/held-sends?ids=${waiting.map((send) => send.sendId).join(",")}`, { timeoutMs: 10_000, rideWake: false })
        .then(heldAnswer, () => null);
      const asked = new Set(waiting.map((send) => send.sendId));
      const { keep, lost } = sortHeldSends(waiting, answer, now());
      writeHeldSends(store, [...readHeldSends(store).filter((send) => !asked.has(send.sendId)), ...keep]);
      for (const send of lost) {
        rememberFailedComposerSend(send.draftId, { sendId: send.sendId, text: send.text, requestText: send.requestText, replyToId: send.replyToId, threadId: send.threadId });
        deps.showError(new SendRefusedError(HELD_NOT_SENT), send.threadId);
      }
    },
    resume: () => outbox.resume(),
    dispose: () => outbox.dispose(),
  };
}
