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
  const readable = plainCause(cause);
  const words = readable.length > FAILED_TURN_MAX_CHARS ? `${readable.slice(0, FAILED_TURN_MAX_CHARS - 1)}…` : readable;
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

function plainCause(cause: string): string {
  const start = cause.indexOf("{");
  if (start < 0) return cause;
  let body: unknown;
  try { body = JSON.parse(cause.slice(start)); } catch { return cause; }
  const said = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
  const record = body && typeof body === "object" ? body as Record<string, unknown> : null;
  const inner = record?.error && typeof record.error === "object" ? record.error as Record<string, unknown> : null;
  const sentence = said(inner?.message) ?? said(record?.error) ?? said(record?.message) ?? said(record?.detail);
  if (!sentence) return cause;
  const lead = cause.slice(0, start).trimEnd();
  return lead ? `${lead} ${sentence}` : sentence;
}

const quotaOf = (quota: FailedTurnQuota): FailedTurnQuota => ({
  ...(typeof quota.kind === "string" && quota.kind ? { kind: quota.kind } : {}),
  ...(typeof quota.resetsAt === "string" && quota.resetsAt ? { resetsAt: quota.resetsAt } : {}),
  ...(typeof quota.instanceId === "string" && quota.instanceId ? { instanceId: quota.instanceId } : {}),
});

export function failedTurnCause(name: string): string | null {
  return name.startsWith(MARKER) ? name.slice(MARKER.length).trim() : null;
}
