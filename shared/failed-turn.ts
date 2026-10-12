import type { PlaceRow } from "./place-view.ts";

const MARKER = "error:";

export const FAILED_TURN_MAX_CHARS = 600;

export interface FailedTurnTool {
  name: string;
  ok: false;
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

export function failedTurnTool(
  cause: string,
  flags: { setup?: boolean; terminal?: boolean; claudeUpdate?: boolean; place?: PlaceRow; quota?: FailedTurnQuota } = {},
): FailedTurnTool {
  const words = cause.length > FAILED_TURN_MAX_CHARS ? `${cause.slice(0, FAILED_TURN_MAX_CHARS - 1)}…` : cause;
  return {
    name: `${MARKER} ${words}`,
    ok: false,
    ...(flags.setup ? { setup: true } : {}),
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
