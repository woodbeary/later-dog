import { composerDraftId, rememberFailedComposerSend } from "@/lib/drafts";
import {
  HELD_ASK_FIRST_MS,
  HELD_NOT_SENT,
  heldAskGroups,
  heldReply,
  heldReplyAfterFailure,
  nextHeldAskDelay,
  readHeldSends,
  sortHeldSends,
  writeHeldSends,
  type HeldSend,
} from "@/lib/held-sends";
import {
  SEND_ATTEMPT_TIMEOUT_MS,
  browserStore,
  createOutbox,
  defaultAfter,
  readOutbox,
  writeOutbox,
  type Outbox,
  type OutboxItem,
} from "@/lib/outbox";
import { EDGE_LINE_PREFIX } from "@/lib/leaf-follow";
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
  pending(bots: readonly Pick<Bot, "messages">[], groups: GroupChats, queues?: unknown): OutboxItem[];
  echoed(sendId: string, line?: { messageId: string; threadId: string }): void;
  queued(queues: unknown): void;
  settleHeld(bots: readonly Pick<Bot, "messages">[], groups: readonly Pick<Group, "messages">[], queues?: unknown): Promise<void>;
  cancelled(queueId: string): void;
  resume(): void;
  dispose(): void;
}

type GroupChats = readonly (Pick<Group, "messages"> & Partial<Pick<Group, "threadId" | "tasks">>)[];

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

function queueRowsWithSendIds(queues: unknown): Array<{ threadId: string; queueId: unknown; sendId: string }> {
  if (typeof queues !== "object" || queues === null) return [];
  return Object.entries(queues as Record<string, unknown>).flatMap(([threadId, entries]) =>
    Array.isArray(entries)
      ? entries.flatMap((entry) => {
          const { sendId, queueId } = (entry ?? {}) as { sendId?: unknown; queueId?: unknown };
          return typeof sendId === "string" && sendId ? [{ threadId, queueId, sendId }] : [];
        })
      : [],
  );
}

export function sendIdsInQueues(queues: unknown): string[] {
  return queueRowsWithSendIds(queues).map((row) => row.sendId);
}

export function sendIdsQueuedAtHome(queues: unknown): string[] {
  return queueRowsWithSendIds(queues).filter((row) => row.queueId !== row.sendId).map((row) => row.sendId);
}

const OPTIMISTIC_LINE_ID = /^optimistic-/;
const EDGE_LINE_ID = new RegExp(`^${EDGE_LINE_PREFIX}`);

type Chats = readonly Pick<Bot | Group, "messages">[];

function sendIdsOnLines(chats: Chats, counts: (messageId: string) => boolean): string[] {
  return chats.flatMap((chat) => (chat.messages ?? []).flatMap((message) => (message.sendId && counts(message.id) ? [message.sendId] : [])));
}

function landedSendIds(bots: Chats, groups: Chats, queues: unknown): Set<string> {
  return new Set([...sendIdsInQueues(queues), ...sendIdsOnLines([...bots, ...groups], (id) => !OPTIMISTIC_LINE_ID.test(id))]);
}

function sendIdsAtHome(bots: Chats, groups: Chats, queues: unknown): Set<string> {
  return new Set([...sendIdsQueuedAtHome(queues), ...sendIdsOnLines([...bots, ...groups], (id) => !OPTIMISTIC_LINE_ID.test(id) && !EDGE_LINE_ID.test(id))]);
}

function threadsOfSendsAtEdge(bots: Chats, groups: Chats, queues: unknown): Map<string, string> {
  const atHome = sendIdsAtHome(bots, groups, queues);
  const threads = new Map<string, string>();
  for (const chat of [...bots, ...groups]) {
    const threadId = (chat as { threadId?: unknown }).threadId;
    for (const message of chat.messages ?? []) {
      if (message.sendId && EDGE_LINE_ID.test(message.id)) threads.set(message.sendId, typeof threadId === "string" ? threadId : "");
    }
  }
  for (const row of queueRowsWithSendIds(queues)) if (row.queueId === row.sendId) threads.set(row.sendId, row.threadId);
  for (const sendId of atHome) threads.delete(sendId);
  return threads;
}

interface Refresh {
  bots: Chats;
  groups: Chats;
  queues: unknown;
}

interface HeldSendKeeper {
  keep(send: HeldSend): void;
  forget(sendId: string): void;
  settle(refresh: Refresh | null): Promise<void>;
  dispose(): void;
}

function createHeldSendKeeper(deps: {
  request: SendOutboxDeps["request"];
  store: Store;
  after: (ms: number, run: () => void) => () => void;
  now: () => number;
  onLost: (send: HeldSend) => void;
  onGone: (send: HeldSend) => void;
}): HeldSendKeeper {
  const { store } = deps;
  let settling: Promise<void> | null = null;
  let followUp: Refresh | null = null;
  let askAgainIn = HELD_ASK_FIRST_MS;
  let stopAskTimer: (() => void) | null = null;
  let disposed = false;
  const forgottenWhileAsking = new Set<string>();

  const stopAsking = () => {
    stopAskTimer?.();
    stopAskTimer = null;
  };

  const askLater = (ms: number) => {
    stopAsking();
    if (disposed || readHeldSends(store).length === 0) return;
    stopAskTimer = deps.after(ms, () => {
      stopAskTimer = null;
      askAgainIn = nextHeldAskDelay(ms);
      void settle(null);
    });
  };

  const settleOnce = async (refresh: Refresh | null): Promise<{ signedIn: boolean }> => {
    const held = readHeldSends(store);
    const atHome = refresh ? sendIdsAtHome(refresh.bots, refresh.groups, refresh.queues) : new Set<string>();
    const waiting = held.filter((send) => !atHome.has(send.sendId));
    if (waiting.length !== held.length) writeHeldSends(store, waiting);
    for (const group of heldAskGroups(waiting)) {
      const ids = group.map((send) => send.sendId);
      const reply = await deps
        .request(`/api/held-sends?ids=${ids.join(",")}`, { timeoutMs: 10_000, rideWake: false })
        .then(heldReply, heldReplyAfterFailure);
      if (reply === "signed-out") return { signedIn: false };
      const asked = new Set(ids);
      const stillWanted = group.filter((send) => !forgottenWhileAsking.has(send.sendId));
      const { keep, lost, gone } = sortHeldSends(stillWanted, reply, deps.now());
      writeHeldSends(store, [...readHeldSends(store).filter((send) => !asked.has(send.sendId)), ...keep]);
      for (const send of lost) deps.onLost(send);
      for (const send of gone) deps.onGone(send);
    }
    return { signedIn: true };
  };

  const settle = (refresh: Refresh | null): Promise<void> => {
    if (refresh) askAgainIn = HELD_ASK_FIRST_MS;
    if (settling) {
      if (refresh) followUp = refresh;
      return settling;
    }
    stopAsking();
    settling = (async () => {
      let signedIn = true;
      try {
        let current = refresh;
        do {
          followUp = null;
          ({ signedIn } = await settleOnce(current));
          current = followUp;
        } while (current);
      } finally {
        settling = null;
        forgottenWhileAsking.clear();
        if (signedIn) askLater(askAgainIn);
      }
    })();
    return settling;
  };

  askLater(askAgainIn);

  return {
    keep(send) {
      writeHeldSends(store, [...readHeldSends(store).filter((held) => held.sendId !== send.sendId), send]);
      askAgainIn = HELD_ASK_FIRST_MS;
      if (!settling) askLater(askAgainIn);
    },
    forget(sendId) {
      const held = readHeldSends(store);
      const rest = held.filter((send) => send.sendId !== sendId);
      if (rest.length !== held.length) writeHeldSends(store, rest);
      if (settling) forgottenWhileAsking.add(sendId);
      else if (rest.length === 0) stopAsking();
    },
    settle,
    dispose() {
      disposed = true;
      stopAsking();
    },
  };
}

export function createSendOutbox(deps: SendOutboxDeps): SendOutbox {
  const store = "store" in deps ? deps.store : browserStore();
  const hooks = new Map<string, SendHooks>();
  const now = deps.now ?? Date.now;
  const heldCopy = (item: OutboxItem, threadId: string): HeldSend => ({
    sendId: item.sendId,
    threadId,
    draftId: item.recovery?.draftId ?? composerDraftId(item.target.kind === "bot" ? { botId: item.target.botId } : { groupId: item.target.groupId }, threadId),
    text: item.recovery?.text ?? item.text,
    requestText: item.text,
    replyToId: item.replyToId,
    at: now(),
  });
  const settle = (item: OutboxItem, body: any) => {
    if (body?.message && typeof body.threadId === "string") {
      deps.dispatch({ type: "messageAdded", threadId: body.threadId, message: body.message });
    }
    const queuedIn = body?.queued && typeof body.queueId === "string" ? (typeof body.threadId === "string" ? body.threadId : item.threadId) : "";
    if (queuedIn) {
      deps.dispatch({ type: "optimisticMessageRemoved", threadId: queuedIn, sendId: item.sendId });
      deps.dispatch({
        type: "pendingQueued",
        threadId: queuedIn,
        queueId: body.queueId,
        text: item.text,
        reason: item.target.kind === "bot" && QUEUE_REASONS.has(body.reason) ? body.reason : undefined,
      });
      if (body.queueId === item.sendId) heldSends.keep(heldCopy(item, queuedIn));
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

  const heldSends = createHeldSendKeeper({
    request: deps.request,
    store,
    after: deps.after ?? defaultAfter,
    now,
    onLost: (send) => {
      deps.dispatch({ type: "consumePendingQueued", threadId: send.threadId, queueId: send.sendId });
      rememberFailedComposerSend(send.draftId, { sendId: send.sendId, text: send.text, requestText: send.requestText, replyToId: send.replyToId, threadId: send.threadId });
      deps.showError(new SendRefusedError(HELD_NOT_SENT), send.threadId);
    },
    onGone: (send) => deps.dispatch({ type: "consumePendingQueued", threadId: send.threadId, queueId: send.sendId }),
  });

  const keepIfAtEdge = (item: OutboxItem, atEdge: ReadonlyMap<string, string>) => {
    const threadId = atEdge.get(item.sendId);
    if (threadId !== undefined) heldSends.keep(heldCopy(item, threadId || item.threadId));
  };

  let heldGroupRowsShown = false;
  const showHeldGroupRows = (bots: Chats, groups: GroupChats, queues: unknown) => {
    if (heldGroupRowsShown) return;
    heldGroupRowsShown = true;
    const groupThreads = new Set(groups.flatMap((group) => [group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]));
    const atHome = sendIdsAtHome(bots, groups, queues);
    for (const send of readHeldSends(store)) {
      if (!groupThreads.has(send.threadId) || atHome.has(send.sendId)) continue;
      deps.dispatch({ type: "pendingQueued", threadId: send.threadId, queueId: send.sendId, text: send.requestText });
    }
  };

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
      showHeldGroupRows(bots, groups, queues);
      const landed = landedSendIds(bots, groups, queues);
      const atEdge = threadsOfSendsAtEdge(bots, groups, queues);
      for (const item of outbox.items()) {
        if (!landed.has(item.sendId)) continue;
        keepIfAtEdge(item, atEdge);
        forget(item.sendId);
      }
      return outbox.items();
    },
    echoed(sendId, line) {
      if (line && EDGE_LINE_ID.test(line.messageId)) {
        const item = outbox.items().find((waiting) => waiting.sendId === sendId);
        if (item) heldSends.keep(heldCopy(item, line.threadId || item.threadId));
      }
      forget(sendId);
    },
    queued(queues) {
      const waiting = new Set(sendIdsInQueues(queues));
      const atEdge = threadsOfSendsAtEdge([], [], queues);
      for (const item of outbox.items()) {
        if (!waiting.has(item.sendId)) continue;
        deps.dispatch({ type: "optimisticMessageRemoved", threadId: item.threadId, sendId: item.sendId });
        keepIfAtEdge(item, atEdge);
        forget(item.sendId);
      }
    },
    settleHeld: (bots, groups, queues) => heldSends.settle({ bots, groups, queues }),
    cancelled: (queueId) => heldSends.forget(queueId),
    resume: () => outbox.resume(),
    dispose: () => {
      heldSends.dispose();
      outbox.dispose();
    },
  };
}
