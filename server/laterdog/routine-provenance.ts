import { AsyncLocalStorage } from "node:async_hooks";

export interface LegacyReportLine {
  id?: string;
  at?: number;
  role?: string;
  kind?: string;
  text?: string;
  ownersRoutine?: boolean;
  routineRun?: { runId: string; routineId: string; routineName: string; scheduledFor?: number; status: string };
}

export interface LegacyRetainedRun {
  id: string;
  routineId: string;
  routineName: string;
  botId: string;
  sourceThreadId?: string;
  scheduledFor: number;
  status: string;
  manual: boolean;
  triggerSource?: string;
  attachments?: unknown[];
  finishedAt?: number;
  deferredAt?: number;
}

export interface LegacyReceiptLine {
  id?: string;
  role?: string;
  kind?: string;
  card?: {
    answered?: string;
    autoApplied?: boolean;
    undone?: boolean;
    routineRequest?: {
      version?: number;
      botId?: string;
      threadId?: string;
      appliedAt?: number;
      resultId?: string;
      operation?: { action?: string; routineId?: string };
      undo?: { ownersBefore?: boolean; before?: { enabled?: boolean; name?: string } };
    };
  };
}

const REPORT_KEYS = new Set(["id", "at", "parentId", "role", "kind", "text", "routineRun"]);
const CARD_KEYS = ["runId", "routineId", "routineName", "scheduledFor", "status"];
const ABSENT_RUN_FIELDS = [
  "startedAt", "threadId", "output", "attention", "error", "denials", "cost", "goalStatus",
  "webhookId", "deliveryId", "executionThreadId",
];

export function cancelledStatusText(routineName: string): string {
  return `Routine “${routineName}” was cancelled`;
}

function canonicalStatusReport(line: LegacyReportLine): boolean {
  const card = line.routineRun;
  if (!card || line.kind !== "routine.run" || line.role !== "bot" || line.ownersRoutine !== undefined) return false;
  if (Object.entries(line).some(([key, value]) => !REPORT_KEYS.has(key) && value !== undefined)) return false;
  if (Object.keys(card).some((key) => !CARD_KEYS.includes(key))) return false;
  if (typeof card.routineName !== "string" || typeof card.scheduledFor !== "number") return false;
  return card.status === "cancelled" && line.text === cancelledStatusText(card.routineName);
}

function retainedRunMatches(card: NonNullable<LegacyReportLine["routineRun"]>, run: LegacyRetainedRun, threadId: string): boolean {
  if (run.id !== card.runId || run.routineId !== card.routineId || run.routineName !== card.routineName) return false;
  if (run.scheduledFor !== card.scheduledFor || run.status !== "cancelled" || run.sourceThreadId !== threadId) return false;
  if (run.manual !== false || (run.triggerSource !== undefined && run.triggerSource !== "schedule")) return false;
  if (!Array.isArray(run.attachments) || run.attachments.length !== 0) return false;
  if (!Object.entries(run).every(([field, value]) => value === undefined || !ABSENT_RUN_FIELDS.includes(field)) || typeof run.finishedAt !== "number") return false;
  return run.deferredAt === undefined
    || (typeof run.deferredAt === "number" && Number.isFinite(run.deferredAt)
      && run.deferredAt >= run.scheduledFor && run.deferredAt <= run.finishedAt);
}

function receiptProves(receipt: LegacyReceiptLine, card: NonNullable<LegacyReportLine["routineRun"]>, run: LegacyRetainedRun, threadId: string): boolean {
  const data = receipt.card?.routineRequest;
  if (receipt.role !== "bot" || receipt.kind !== "options" || !data) return false;
  if (receipt.card?.autoApplied !== true || receipt.card.answered !== "allow" || receipt.card.undone === true) return false;
  if (data.version !== 1 || data.threadId !== threadId || data.botId !== run.botId) return false;
  if (data.operation?.action !== "delete" || data.operation.routineId !== card.routineId || data.resultId !== card.routineId) return false;
  if (typeof data.appliedAt !== "number" || run.finishedAt! > data.appliedAt) return false;
  return data.undo?.ownersBefore === true && data.undo.before?.enabled === false && data.undo.before.name === card.routineName;
}

export function legacyCancelledStatusIsNeutral(
  line: LegacyReportLine,
  threadId: string,
  retainedRun: (runId: string) => LegacyRetainedRun | undefined,
  attestation: (runId: string) => boolean | undefined,
  threadMessages: () => readonly LegacyReceiptLine[],
): boolean {
  if (!canonicalStatusReport(line)) return false;
  const card = line.routineRun!;
  const run = retainedRun(card.runId);
  if (!run || attestation(run.id) === false || !retainedRunMatches(card, run, threadId)) return false;
  return threadMessages().some((receipt) => receiptProves(receipt, card, run, threadId));
}

export interface OwnerRunNowScope {
  within<T>(invoke: () => T): T;
  active(): boolean;
}

export function createOwnerRunNowScope(): OwnerRunNowScope {
  const storage = new AsyncLocalStorage<true>();
  return {
    within: (invoke) => storage.run(true, invoke),
    active: () => storage.getStore() === true,
  };
}
