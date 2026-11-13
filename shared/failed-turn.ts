import type { PlaceRow } from "./place-view.ts";
import { plainFailure, type PlainFailure } from "./plain-failure.ts";
import { isProviderSafetyBlock } from "./provider-safety.ts";

const MARKER = "error:";

export const FAILED_TURN_MAX_CHARS = 600;

export interface FailedTurnTool {
  name: string;
  ok: false;
  detail?: string;
  setup?: boolean;
  terminal?: boolean;
  claudeUpdate?: boolean;
  place?: PlaceRow;
  quota?: FailedTurnQuota;
}

export interface FailedTurnQuota {
  kind?: string;
  resetsAt?: string;
  instanceId?: string;
}

export interface FailedTurnFlags {
  setup?: boolean;
  terminal?: boolean;
  claudeUpdate?: boolean;
  place?: PlaceRow;
  quota?: FailedTurnQuota;
  who?: string;
  written?: boolean;
}

const KEEPS_ITS_WORDS = /^CUA Driver is not ready\b|subscription_sharing_usage_limit_exceeded/;

function keepsItsWords(cause: string, flags: FailedTurnFlags): boolean {
  return Boolean(flags.written || flags.setup || flags.claudeUpdate || flags.place || flags.quota)
    || isProviderSafetyBlock(cause) || KEEPS_ITS_WORDS.test(cause);
}

export function failedTurnTool(cause: string, flags: FailedTurnFlags = {}): FailedTurnTool {
  const plain: PlainFailure = keepsItsWords(cause, flags) ? { line: cause } : plainFailure(cause, flags.who);
  const readable = plain.line;
  const words = readable.length > FAILED_TURN_MAX_CHARS ? `${readable.slice(0, FAILED_TURN_MAX_CHARS - 1)}…` : readable;
  return {
    name: `${MARKER} ${words}`,
    ok: false,
    ...(plain.detail ? { detail: plain.detail } : {}),
    ...(flags.setup || plain.setup ? { setup: true } : {}),
    ...(flags.terminal ? { terminal: true } : {}),
    ...(flags.claudeUpdate ? { claudeUpdate: true } : {}),
    ...(flags.place ? { place: flags.place } : {}),
    ...(flags.quota ? { quota: quotaOf(flags.quota) } : {}),
  };
}

const quotaOf = (quota: FailedTurnQuota): FailedTurnQuota => ({
  ...(typeof quota.kind === "string" && quota.kind ? { kind: quota.kind } : {}),
  ...(typeof quota.resetsAt === "string" && quota.resetsAt ? { resetsAt: quota.resetsAt } : {}),
  ...(typeof quota.instanceId === "string" && quota.instanceId ? { instanceId: quota.instanceId } : {}),
});

export function failedTurnCause(name: string): string | null {
  return name.startsWith(MARKER) ? name.slice(MARKER.length).trim() : null;
}
