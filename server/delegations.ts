
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { getOrCreateChannel, mirrorExchange, type CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import { failedTurnTool } from "../shared/failed-turn.ts";
import { newId } from "./contracts.ts";
import { peerApprovalFailure, requestPeerApproval, type ApprovalBus, type PeerApprovalFailure } from "./peer-approval.ts";
import { canReachPeer } from "./peer-roster.ts";
import { type BotRecord, type GroupRecord, type Message, type Store } from "./store.ts";

export interface DelegationItem {
  toBotId: string;
  message: string;
  reason?: string;
  approvalAlreadyGranted?: boolean;
  depth: number;
  originatingGroupId?: string;
  targetThreadId?: string;
  oneWay?: boolean;
  completionOwner?: "external";
  continuesThread?: boolean;
}

interface PendingDelegationItem extends DelegationItem {
  id: string;
  sourceBotId: string;
  queuedAt: number;
  waitAnnounced?: boolean;
  waitingOnBusy?: boolean;
  busySince?: number;
}

export type DelegationOutcome = "done" | "failed" | "denied" | "expired" | "cancelled" | "busy_gave_up" | "dropped" | "error";

export interface DelegationReceipt {
  id: string;
  sourceThreadId: string;
  toBotId: string;
  toBotName: string;
  status: DelegationOutcome;
  approvalOutcome?: PeerApprovalFailure;
  approvalSource?: "user" | "system";
  result?: string;
  finishedAt: number;
}

export type QueueResult = "ok" | "no_target" | "self" | "too_deep" | "too_many";

export interface QueuedDelegation {
  result: QueueResult;
  id?: string;
}

const pendingDelegations = new Map<string, PendingDelegationItem[]>();
const drainingThreads = new Set<string>();
const queuedRedrains = new Set<string>();
const DELEGATIONS_FILE = join(DATA_DIR, "delegations.json");
const RECEIPTS_FILE = join(DATA_DIR, "delegation-receipts.json");
const MAX_RECEIPTS = 100;
const RECEIPT_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const RESULT_MAX_CHARS = 4_000;

export const DELEGATION_TTL_MS = 24 * 60 * 60 * 1000;

const configuredBusyHoldMaxMs = Number(process.env.LATERDOG_DELEGATION_BUSY_HOLD_MAX_MS);
export const DELEGATION_BUSY_HOLD_MAX_MS = Math.max(
  1_000,
  Number.isFinite(configuredBusyHoldMaxMs) && process.env.LATERDOG_DELEGATION_BUSY_HOLD_MAX_MS !== "" ? configuredBusyHoldMaxMs : 2 * 60 * 60 * 1000,
);

let receipts: DelegationReceipt[] = [];

function saveReceipts(): void {
  try {
    writeFileAtomic(RECEIPTS_FILE, JSON.stringify(receipts, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error("delegations: could not persist receipts", error);
  }
}

export function recordDelegationReceipt(receipt: Omit<DelegationReceipt, "finishedAt"> & { finishedAt?: number }): void {
  const now = Date.now();
  const bounded: DelegationReceipt = {
    id: receipt.id,
    sourceThreadId: receipt.sourceThreadId,
    toBotId: receipt.toBotId,
    toBotName: receipt.toBotName,
    status: receipt.status,
    finishedAt: receipt.finishedAt ?? now,
  };
  if (receipt.result !== undefined) bounded.result = receipt.result.slice(0, RESULT_MAX_CHARS);
  if (receipt.approvalOutcome !== undefined) {
    bounded.approvalOutcome = receipt.approvalOutcome;
    bounded.approvalSource = peerApprovalFailure(receipt.approvalOutcome).approvalSource;
  }
  receipts = [bounded, ...receipts.filter((existing) => existing.id !== bounded.id)]
    .filter((existing) => now - existing.finishedAt <= RECEIPT_MAX_AGE_MS)
    .slice(0, MAX_RECEIPTS);
  saveReceipts();
}

export function findDelegationReceipt(id: string): DelegationReceipt | null {
  return receipts.find((receipt) => receipt.id === id) ?? null;
}

export function pendingDelegationInfo(
  id: string,
): { sourceThreadId: string; toBotId: string; queuedAt: number; waiting: boolean } | null {
  for (const [sourceThreadId, items] of pendingDelegations) {
    const item = items.find((candidate) => candidate.id === id);
    if (item) return { sourceThreadId, toBotId: item.toBotId, queuedAt: item.queuedAt, waiting: item.waitingOnBusy === true };
  }
  return null;
}

export function threadsWaitingOn(toBotId: string): string[] {
  return [...pendingDelegations.entries()]
    .filter(([, items]) => items.some((item) => item.toBotId === toBotId && item.waitingOnBusy === true))
    .map(([threadId]) => threadId);
}

export function releaseDelegationsWaitingOn(toBotId: string, only?: (item: DelegationItem) => boolean): string[] {
  const released: string[] = [];
  for (const [threadId, items] of pendingDelegations) {
    let any = false;
    for (const item of items) {
      if (item.toBotId !== toBotId || item.waitingOnBusy !== true || (only && !only(item))) continue;
      delete item.waitingOnBusy;
      delete item.busySince;
      any = true;
    }
    if (any) released.push(threadId);
  }
  if (released.length) savePending();
  return released;
}

function savePending(): void {
  try {
    writeFileAtomic(DELEGATIONS_FILE, JSON.stringify(Object.fromEntries(pendingDelegations), null, 2), { mode: 0o600 });
  } catch (error) {
    console.error("delegations: could not persist queue", error);
  }
}

export function _loadPending(): void {
  pendingDelegations.clear();
  let backfilled = false;
  try {
    const raw = JSON.parse(readFileSync(DELEGATIONS_FILE, "utf8")) as Record<string, unknown>;
    const now = Date.now();
    for (const [threadId, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      const items = list.flatMap((value): PendingDelegationItem[] => {
        if (!value || typeof value !== "object") return [];
        const item = value as Partial<PendingDelegationItem>;
        if (
          typeof item.toBotId !== "string" ||
          typeof item.message !== "string" ||
          !Number.isFinite(item.depth)
        ) return [];
        const hasUsableQueuedAt = Number.isFinite(item.queuedAt) && item.queuedAt! <= now &&
          now - item.queuedAt! < DELEGATION_TTL_MS;
        if (!hasUsableQueuedAt) backfilled = true;
        const legacyAttempts = (value as { attempts?: unknown }).attempts;
        const legacyAlreadyAnnounced = typeof legacyAttempts === "number" && Number.isFinite(legacyAttempts) && legacyAttempts > 0;
        const loaded: PendingDelegationItem = {
          id: typeof item.id === "string" && item.id ? item.id : newId(),
          sourceBotId: typeof item.sourceBotId === "string" && item.sourceBotId ? item.sourceBotId : "",
          toBotId: item.toBotId,
          message: item.message,
          ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
          depth: Math.max(0, Math.trunc(item.depth!)),
          queuedAt: hasUsableQueuedAt ? Math.min(item.queuedAt!, now) : now,
        };
        if (item.approvalAlreadyGranted === true) loaded.approvalAlreadyGranted = true;
        if (item.waitingOnBusy === true) {
          loaded.waitingOnBusy = true;
          const currentHold = Number.isFinite(item.busySince) && item.busySince! <= now &&
            now - item.busySince! < DELEGATION_BUSY_HOLD_MAX_MS;
          loaded.busySince = currentHold ? item.busySince : now;
          if (!currentHold) backfilled = true;
        }
        if (item.waitAnnounced === true || legacyAlreadyAnnounced) loaded.waitAnnounced = true;
        if (typeof item.originatingGroupId === "string" && item.originatingGroupId) {
          loaded.originatingGroupId = item.originatingGroupId;
        }
        if (typeof item.targetThreadId === "string" && item.targetThreadId) {
          loaded.targetThreadId = item.targetThreadId;
        }
        if (item.oneWay === true) loaded.oneWay = true;
        if (item.completionOwner === "external") loaded.completionOwner = "external";
        return [loaded];
      });
      if (items.length) pendingDelegations.set(threadId, items);
    }
  } catch {}
  if (backfilled) savePending();
  receipts = [];
  try {
    const rawReceipts = JSON.parse(readFileSync(RECEIPTS_FILE, "utf8"));
    if (Array.isArray(rawReceipts)) {
      const now = Date.now();
      const loaded: DelegationReceipt[] = [];
      for (const value of rawReceipts) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const candidate = value as Partial<DelegationReceipt>;
        const { id, sourceThreadId, toBotId, toBotName, status, result, finishedAt } = candidate;
        if (typeof id !== "string" || !id) continue;
        if (typeof sourceThreadId !== "string" || typeof toBotId !== "string") continue;
        if (typeof toBotName !== "string" || typeof status !== "string") continue;
        if (!Number.isFinite(finishedAt) || now - finishedAt! > RECEIPT_MAX_AGE_MS) continue;
        const receipt: DelegationReceipt = { id, sourceThreadId, toBotId, toBotName, status, finishedAt: finishedAt! };
        if (typeof result === "string") receipt.result = result;
        if (candidate.approvalOutcome === "deny" || candidate.approvalOutcome === "expired" || candidate.approvalOutcome === "cancelled") {
          receipt.approvalOutcome = candidate.approvalOutcome;
          receipt.approvalSource = peerApprovalFailure(candidate.approvalOutcome).approvalSource;
        }
        loaded.push(receipt);
      }
      receipts = loaded.slice(0, MAX_RECEIPTS);
    }
  } catch {}
}

export function pendingThreads(): string[] {
  return [...pendingDelegations.keys()];
}

export function pendingDelegationSnapshot(): Array<{
  sourceThreadId: string;
  sourceBotId: string;
  toBotId: string;
  reason?: string;
  targetThreadId?: string;
}> {
  return [...pendingDelegations.entries()].flatMap(([sourceThreadId, items]) =>
    items.map((item) => ({
      sourceThreadId,
      sourceBotId: item.sourceBotId,
      toBotId: item.toBotId,
      ...(item.reason ? { reason: item.reason } : {}),
      ...(item.targetThreadId ? { targetThreadId: item.targetThreadId } : {}),
    })),
  );
}

const MAX_QUEUED_PER_THREAD = 6;

export function queueDelegation(
  bus: CommsBus,
  from: BotRecord,
  item: DelegationItem,
  maxDepth: number,
  sourceThreadId = from.threadId,
): QueuedDelegation {
  if (item.toBotId === from.id) return { result: "self" };
  if (!item.oneWay && item.depth >= maxDepth) return { result: "too_deep" };
  const target = bus.store.bot(item.toBotId);
  if (!target) return { result: "no_target" };
  const list = pendingDelegations.get(sourceThreadId) ?? [];
  if (list.length >= MAX_QUEUED_PER_THREAD) return { result: "too_many" };
  const originatingGroup = item.originatingGroupId
    ? bus.store.group(item.originatingGroupId)
    : (sourceThreadId ? bus.store.groupByThread(sourceThreadId) : undefined);
  const groupId =
    originatingGroup &&
    !originatingGroup.dm &&
    originatingGroup.memberIds.includes(from.id) &&
    originatingGroup.memberIds.includes(target.id)
      ? originatingGroup.id
      : undefined;
  const id = newId();
  list.push({ ...item, id, sourceBotId: from.id, queuedAt: Date.now(), ...(groupId ? { originatingGroupId: groupId } : {}) });
  pendingDelegations.set(sourceThreadId, list);
  savePending();
  const sourceGroup = sourceThreadId ? bus.store.groupByThread(sourceThreadId) : undefined;
  const openedThread = item.targetThreadId ? bus.store.taskByThread(target.id, item.targetThreadId) : undefined;
  const chip: Omit<Message, "id" | "at"> = {
    role: "bot",
    kind: "activity",
    tool: {
      name: openedThread
        ? item.continuesThread
          ? `Added to thread #${openedThread.title} on ${target.name}`
          : `Opened thread #${openedThread.title} on ${target.name}`
        : `Delegated to @${target.name}${item.reason ? `: ${item.reason}` : ""}`,
      ok: true,
    },
  };
  if (openedThread) chip.threadRef = { botId: target.id, threadId: openedThread.threadId, title: openedThread.title };
  if (sourceGroup && !sourceGroup.dm) chip.from = { botId: from.id, name: from.name, color: from.color };
  bus.store.appendMessage(sourceThreadId, chip);
  return { result: "ok", id };
}

export function drainDelegations(
  bus: CommsBus,
  approvalBus: ApprovalBus,
  threadId: string,
  runTarget: (
    toBotId: string,
    message: string,
    commsDepth: number,
    sourceThreadId: string,
    channel: GroupRecord | undefined,
    taskId: string,
    sourceBotId: string,
    targetThreadId: string | undefined,
    oneWay: boolean,
    completionOwner?: "external",
  ) => void | Promise<void>,
  onSettled?: (receipt: DelegationReceipt) => void,
): void {
  if (drainingThreads.has(threadId)) {
    queuedRedrains.add(threadId);
    return;
  }
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return;
  const snapshot = [...list];
  drainingThreads.add(threadId);
  void (async () => {
    for (const item of snapshot) {
      if (!pendingDelegations.get(threadId)?.some((candidate) => candidate.id === item.id)) continue;
      const from =
        bus.store.botByThread(threadId) ??
        bus.store.bot(item.sourceBotId);
      if (!from) {
        appendDeliveryMessage(bus, threadId, item, {
          role: "bot",
          kind: "activity",
          tool: { name: "Send failed — the sending dog no longer exists", ok: false },
        });
        recordDelegationReceipt({
          id: item.id,
          sourceThreadId: threadId,
          toBotId: item.toBotId,
          toBotName: bus.store.bot(item.toBotId)?.name ?? item.toBotId,
          status: "dropped",
          result: "the delegating bot no longer exists",
        });
        acknowledgeDelegation(threadId, item.id);
        continue;
      }
      let outcome: "settled" | "requeued" | "dispatched" = "settled";
      try {
        outcome = await processOne(bus, approvalBus, from, threadId, item, runTarget);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        recordDelegationReceipt({
          id: item.id,
          sourceThreadId: threadId,
          toBotId: item.toBotId,
          toBotName: bus.store.bot(item.toBotId)?.name ?? item.toBotId,
          status: "error",
          result: why.slice(0, 200),
        });
        try {
          appendDeliveryMessage(bus, threadId, item, {
            role: "bot",
            kind: "activity",
            tool: failedTurnTool(`delegation failed — ${why}`),
          });
        } catch (reportError) {
          console.error("delegation failed and could not be reported", reportError);
        }
      } finally {
        const stillQueued = pendingDelegations.get(threadId)?.some((candidate) => candidate.id === item.id);
        if (outcome !== "requeued") acknowledgeDelegation(threadId, item.id);
        if (outcome === "settled" && stillQueued) {
          const receipt = findDelegationReceipt(item.id);
          try {
            if (receipt && wakesSource(item)) onSettled?.(receipt);
          } catch (error) {
            console.error("delegation settled but its source could not be resumed", error);
          }
        }
      }
    }
  })().finally(() => {
    drainingThreads.delete(threadId);
    const redrainRequested = queuedRedrains.delete(threadId);
    const snapshotIds = new Set(snapshot.map((item) => item.id));
    const hasNewItems = pendingDelegations.get(threadId)?.some((item) => !snapshotIds.has(item.id)) ?? false;
    if (redrainRequested || hasNewItems) {
      drainDelegations(bus, approvalBus, threadId, runTarget, onSettled);
    }
  });
}

function acknowledgeDelegation(threadId: string, itemId: string): void {
  const current = pendingDelegations.get(threadId);
  if (!current) return;
  const remaining = current.filter((item) => item.id !== itemId);
  if (remaining.length) pendingDelegations.set(threadId, remaining);
  else pendingDelegations.delete(threadId);
  savePending();
}

function appendDeliveryMessage(
  bus: CommsBus,
  sourceThreadId: string,
  item: PendingDelegationItem,
  message: Omit<Message, "id" | "at">,
): void {
  const threadId = item.oneWay && item.targetThreadId && bus.store.taskByThread(item.toBotId, item.targetThreadId)
    ? item.targetThreadId : sourceThreadId;
  if (item.oneWay && threadId === sourceThreadId && !sourceThreadBelongsToBot(bus.store, item.sourceBotId, sourceThreadId)) return;
  bus.store.appendMessage(threadId, message);
}

const wakesSource = (item: DelegationItem): boolean => !item.oneWay && item.completionOwner !== "external";

const isExpired = (item: PendingDelegationItem, now: number): boolean => now - item.queuedAt >= DELEGATION_TTL_MS;

const busyHoldExpired = (item: PendingDelegationItem, now: number): boolean =>
  item.busySince !== undefined && now - item.busySince >= DELEGATION_BUSY_HOLD_MAX_MS;

export function busyHoldCapText(maxMs = DELEGATION_BUSY_HOLD_MAX_MS): string {
  const minutes = Math.max(1, Math.round(maxMs / 60_000));
  const amount = minutes % 60 === 0 ? minutes / 60 : minutes;
  const unit = minutes % 60 === 0 ? "hour" : "minute";
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}

function expireDelegation(bus: CommsBus, sourceThreadId: string, item: PendingDelegationItem, ownerId: string): void {
  const target = bus.store.bot(item.toBotId);
  const name = target?.name ?? item.toBotId;
  const now = Date.now();
  const busyHold = Boolean(target) && busyHoldExpired(item, now) && !isExpired(item, now);
  recordDelegationReceipt({
    id: item.id,
    sourceThreadId,
    toBotId: item.toBotId,
    toBotName: name,
    status: "expired",
    result: busyHold ? `@${name} was still busy after ${busyHoldCapText()}` : `@${name} was not free to take this for 24 hours`,
  });
  if (!item.oneWay && !sourceThreadBelongsToBot(bus.store, ownerId, sourceThreadId)) return;
  appendDeliveryMessage(bus, sourceThreadId, item, {
    role: "bot",
    kind: "activity",
    tool: {
      name: busyHold
        ? `Delegation to @${name} expired — still busy after ${busyHoldCapText()}`
        : `Delegation to @${name} expired — not picked up within 24 hours`,
      ok: false,
    },
  });
}

function isDueForExpiry(bus: CommsBus, item: PendingDelegationItem, now: number): boolean {
  const target = bus.store.bot(item.toBotId);
  if (!target) return isExpired(item, now);
  return !targetCanTakeTurn(bus, target, item) && (isExpired(item, now) || busyHoldExpired(item, now));
}

export function expireStaleDelegations(
  bus: CommsBus,
  now: number,
  onSettled?: (receipt: DelegationReceipt) => void,
): number {
  const expired: Array<{ receipt: DelegationReceipt; wake: boolean }> = [];
  for (const [threadId, items] of pendingDelegations) {
    if (drainingThreads.has(threadId)) continue;
    const due = items.filter((item) => isDueForExpiry(bus, item, now));
    if (!due.length) continue;
    const remaining = items.filter((item) => !isDueForExpiry(bus, item, now));
    if (remaining.length) pendingDelegations.set(threadId, remaining);
    else pendingDelegations.delete(threadId);
    const ownerId = bus.store.botByThread(threadId)?.id;
    for (const item of due) {
      expireDelegation(bus, threadId, item, ownerId ?? item.sourceBotId);
      const receipt = findDelegationReceipt(item.id);
      if (receipt) expired.push({ receipt, wake: wakesSource(item) });
    }
  }
  if (!expired.length) return 0;
  savePending();
  for (const { receipt, wake } of expired) {
    try {
      if (wake) onSettled?.(receipt);
    } catch (error) {
      console.error("delegation expired but its source could not be resumed", error);
    }
  }
  return expired.length;
}

export function discardDelegations(bus: CommsBus, threadId: string): void {
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return;
  const kept = list.filter(item => item.oneWay);
  const dropped = list.filter(item => !item.oneWay);
  if (kept.length) pendingDelegations.set(threadId, kept);
  else pendingDelegations.delete(threadId);
  savePending();
  for (const item of dropped) {
    recordDelegationReceipt({
      id: item.id,
      sourceThreadId: threadId,
      toBotId: item.toBotId,
      toBotName: bus.store.bot(item.toBotId)?.name ?? item.toBotId,
      status: "dropped",
      result: "the delegating turn did not finish",
    });
  }
  if (!dropped.length) return;
  const from =
    bus.store.botByThread(threadId) ??
    bus.store.bot(dropped.find((item) => bus.store.bot(item.sourceBotId))?.sourceBotId ?? dropped[0]!.sourceBotId);
  if (!from) return;
  bus.store.appendMessage(threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `${dropped.length} queued delegation${dropped.length > 1 ? "s" : ""} dropped — the turn did not finish`, ok: false },
  });
}

async function processOne(
  bus: CommsBus,
  approvalBus: ApprovalBus,
  from: BotRecord,
  sourceThreadId: string,
  item: PendingDelegationItem,
  runTarget: (
    toBotId: string,
    message: string,
    commsDepth: number,
    sourceThreadId: string,
    channel: GroupRecord | undefined,
    taskId: string,
    sourceBotId: string,
    targetThreadId: string | undefined,
    oneWay: boolean,
    completionOwner?: "external",
  ) => void | Promise<void>,
): Promise<"settled" | "requeued" | "dispatched"> {
  let sender = from;
  let target = bus.store.bot(item.toBotId);
  if (!item.oneWay && !sourceThreadBelongsToBot(bus.store, sender.id, sourceThreadId)) {
    recordDelegationReceipt({
      id: item.id,
      sourceThreadId,
      toBotId: item.toBotId,
      toBotName: target?.name ?? item.toBotId,
      status: "dropped",
      result: "the source conversation no longer belongs to the delegating bot",
    });
    return "settled";
  }
  if (!target) {
    recordDelegationReceipt({
      id: item.id,
      sourceThreadId,
      toBotId: item.toBotId,
      toBotName: item.toBotId,
      status: "error",
      result: "no such bot",
    });
    appendDeliveryMessage(bus, sourceThreadId, item, {
      role: "bot",
      kind: "activity",
      tool: failedTurnTool(`delegation to ${item.toBotId} failed — no such bot`),
    });
    return "settled";
  }
  if (dropIfUnreachable(bus, sender, target, sourceThreadId, item)) {
    return "settled";
  }
  if (dropIfThreadGone(bus, target, sourceThreadId, item)) {
    return "settled";
  }
  const canTakeTurn = targetCanTakeTurn(bus, target, item);
  if (!canTakeTurn && (isExpired(item, Date.now()) || busyHoldExpired(item, Date.now()))) {
    expireDelegation(bus, sourceThreadId, item, sender.id);
    return "settled";
  }
  const held = holdWhileTargetBusy(bus, target, sourceThreadId, item, canTakeTurn);
  if (held) return held;
  if (item.waitingOnBusy) {
    delete item.waitingOnBusy;
    delete item.busySince;
    savePending();
  }
  if (sender.approvePeerComms && !item.approvalAlreadyGranted) {
    const verdict = await requestPeerApproval(
      approvalBus,
      sender,
      target,
      item.message,
      "delegate_bot",
      sourceThreadId,
    );
    if (!pendingDelegations.get(sourceThreadId)?.some((candidate) => candidate.id === item.id)) return "settled";
    const current = bus.store.bot(item.toBotId);
    const currentSender = bus.store.bot(from.id);
    if (!current || !currentSender || (!item.oneWay && !sourceThreadBelongsToBot(bus.store, currentSender.id, sourceThreadId))) {
      recordDelegationReceipt({
        id: item.id,
        sourceThreadId,
        toBotId: item.toBotId,
        toBotName: target.name,
        status: "dropped",
        result: "the peer or source conversation no longer exists",
        ...(verdict !== "allow" ? { approvalOutcome: verdict } : {}),
      });
      return "settled";
    }
    if (verdict !== "allow") {
      const failure = peerApprovalFailure(verdict);
      recordDelegationReceipt({
        id: item.id,
        sourceThreadId,
        toBotId: target.id,
        toBotName: target.name,
        status: verdict === "deny" ? "denied" : verdict,
        approvalOutcome: verdict,
        result: verdict === "deny" ? "the user denied this handoff" : failure.error,
      });
      appendDeliveryMessage(bus, sourceThreadId, item, {
        role: "bot",
        kind: "activity",
        tool: { name: verdict === "deny" ? `Delegation to @${target.name} denied by user`
          : `Delegation to @${target.name}: ${failure.error}`, ok: false },
      });
      return "settled";
    }
    item.approvalAlreadyGranted = true;
    savePending();
    if (dropIfUnreachable(bus, currentSender, current, sourceThreadId, item)) {
      return "settled";
    }
    if (dropIfThreadGone(bus, current, sourceThreadId, item)) {
      return "settled";
    }
    const canTakeTurnAfterApproval = targetCanTakeTurn(bus, current, item);
    if (!canTakeTurnAfterApproval && (isExpired(item, Date.now()) || busyHoldExpired(item, Date.now()))) {
      expireDelegation(bus, sourceThreadId, item, currentSender.id);
      return "settled";
    }
    const heldAfterApproval = holdWhileTargetBusy(bus, current, sourceThreadId, item, canTakeTurnAfterApproval);
    if (heldAfterApproval) return heldAfterApproval;
    sender = currentSender;
    target = current;
  }
  const originatingGroup =
    (item.originatingGroupId ? bus.store.group(item.originatingGroupId) : undefined) ??
    (sourceThreadId ? bus.store.groupByThread(sourceThreadId) : undefined);
  const channel = item.oneWay ? undefined : getOrCreateChannel(bus.store, sender, target, originatingGroup);
  if (channel) mirrorExchange(bus, sender, target, item.message, channel, sourceThreadId);
  const reasonLine = item.reason ? `\n\n[Reason: ${item.reason}]` : "";
  const prefixed = item.targetThreadId
    ? item.message
    : `[Delegated by @${sender.name}, another bot in this later.dog workspace. Do the work and reply directly.]\n\n${item.message}${reasonLine}`;
  await runTarget(item.toBotId, prefixed, item.oneWay ? 0 : item.depth + 1, sourceThreadId, channel, item.id, sender.id, item.targetThreadId, item.oneWay === true, item.completionOwner);
  return "dispatched";
}

function targetCanTakeTurn(bus: CommsBus, target: BotRecord, item: PendingDelegationItem): boolean {
  return item.targetThreadId
    ? (bus.threadSlotFree ? bus.threadSlotFree(target.id) : !target.busy)
    : bus.canAdmitDirectTurn
      ? bus.canAdmitDirectTurn(target.id, target.threadId)
      : !target.busy;
}

function holdWhileTargetBusy(
  bus: CommsBus,
  target: BotRecord,
  sourceThreadId: string,
  item: PendingDelegationItem,
  canTakeTurn: boolean = targetCanTakeTurn(bus, target, item),
): "requeued" | null {
  if (canTakeTurn) return null;
  if (item.waitingOnBusy) return "requeued";
  item.waitingOnBusy = true;
  item.busySince = Date.now();
  if (!item.waitAnnounced) {
    item.waitAnnounced = true;
    appendDeliveryMessage(bus, sourceThreadId, item, {
      role: "bot",
      kind: "activity",
      tool: { name: waitingChipText(bus.store, target, item) },
    });
  }
  savePending();
  return "requeued";
}

function waitingChipText(store: Store, target: BotRecord, item: PendingDelegationItem): string {
  if (item.targetThreadId) {
    const title = store.taskByThread(target.id, item.targetThreadId)?.title ?? "thread";
    return `Thread #${title} on @${target.name} waiting for a free slot`;
  }
  if (target.activity === "waiting-on-you") {
    return `Waiting for @${target.name}, who's waiting on you — it'll go through after you answer`;
  }
  return `Delegation to @${target.name} waiting — they're busy; it'll go through when they're free`;
}

function dropIfThreadGone(
  bus: CommsBus,
  target: BotRecord,
  sourceThreadId: string,
  item: PendingDelegationItem,
): boolean {
  if (!item.targetThreadId || bus.store.taskByThread(target.id, item.targetThreadId)) return false;
  recordDelegationReceipt({
    id: item.id,
    sourceThreadId,
    toBotId: target.id,
    toBotName: target.name,
    status: "dropped",
    result: `the thread opened on @${target.name} was deleted before it could start`,
  });
  appendDeliveryMessage(bus, sourceThreadId, item, {
    role: "bot",
    kind: "activity",
    tool: { name: `Thread on @${target.name} canceled — it was deleted before it could start`, ok: false },
  });
  return true;
}

function sourceThreadBelongsToBot(store: Store, botId: string, threadId: string): boolean {
  if (store.taskByThread(botId, threadId)) return true;
  const group = store.groupByThread(threadId);
  return Boolean(group && group.memberIds.includes(botId));
}

function dropIfUnreachable(
  bus: CommsBus,
  sender: BotRecord,
  target: BotRecord,
  sourceThreadId: string,
  item: PendingDelegationItem,
): boolean {
  if (canReachPeer(sender, target)) return false;
  const reason = `@${target.name} is no longer an allowed peer`;
  const result = `@${sender.name} is no longer allowed to contact @${target.name}`;
  recordDelegationReceipt({
    id: item.id,
    sourceThreadId,
    toBotId: target.id,
    toBotName: target.name,
    status: "dropped",
    result,
  });
  appendDeliveryMessage(bus, sourceThreadId, item, {
    role: "bot",
    kind: "activity",
    tool: { name: `Delegation to @${target.name} canceled — ${reason}`, ok: false },
  });
  return true;
}

export function _pendingCount(threadId: string): number {
  return pendingDelegations.get(threadId)?.length ?? 0;
}

export function _resetPending(): void {
  pendingDelegations.clear();
  drainingThreads.clear();
  queuedRedrains.clear();
  receipts = [];
}


export function buildDelegationRevivalPrompt(targetName: string): string {
  return [
    "[A delegated task just completed]",
    `The task you delegated to @${targetName} has finished, and their reply is now in this conversation.`,
    "Pick the work back up: review the reply, then answer the user with the outcome — lead with the concrete result and say what happens next. Do not re-delegate the same task.",
  ].join("\n\n");
}

export function buildDelegationFailurePrompt(targetName: string, reason: string): string {
  return [
    "[A delegated task failed]",
    `The task you delegated to @${targetName} did not finish: ${reason}`,
    "Take over: tell the user what failed in plain terms, then decide the next step — retry with a narrower task, do the work yourself, or propose an alternative. Do not re-delegate the exact same task unchanged.",
  ].join("\n\n");
}

export const DELEGATION_WAKE_MAX_PER_WINDOW = 6;
export const DELEGATION_WAKE_WINDOW_MS = 5 * 60 * 1000;

export class DelegationWakeBudget {
  private readonly entries = new Map<string, { count: number; windowStart: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  tryAcquire(threadId: string): boolean {
    const now = this.now();
    const entry = this.entries.get(threadId);
    if (!entry || now - entry.windowStart >= DELEGATION_WAKE_WINDOW_MS) {
      this.entries.set(threadId, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= DELEGATION_WAKE_MAX_PER_WINDOW) return false;
    entry.count += 1;
    return true;
  }

  reset(threadId: string): void {
    this.entries.delete(threadId);
  }
}


export interface DelegatedActivityMessage {
  at: number;
  kind: string;
  text?: string;
  tool?: { name?: string } | null;
}

export function formatDelegationElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.round(elapsedMs / 1_000));
  if (totalSeconds < 90) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function summarizeDelegatedActivity(
  messages: readonly DelegatedActivityMessage[],
  startedAtMs: number,
  limit = 5,
): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.at < startedAtMs) continue;
    if (message.kind === "activity") {
      const name = (message.tool?.name ?? "").trim();
      if (name) lines.push(`tool: ${name}`);
      continue;
    }
    if (message.kind === "text" && message.text?.trim()) {
      const text = message.text.trim().replace(/\s+/g, " ");
      lines.push(`text: ${text.slice(0, 140)}${text.length > 140 ? "…" : ""}`);
    }
  }
  return lines.slice(-limit);
}
