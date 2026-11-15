import { WAIT_IN_ONE_CALL_MS } from "./computer-runs.ts";

export const LONGEST_WAIT_MINUTES = 60;
export const STILL_RUNNING_TAIL_CHARS = 2_000;

const MINUTE_MS = 60_000;

export function waitCapMs(driverKind: string | undefined, mcpCallTimeoutMinutes: number): number {
  if (driverKind === "claudeAgent") return LONGEST_WAIT_MINUTES * MINUTE_MS;
  return Math.max(WAIT_IN_ONE_CALL_MS, Math.min(LONGEST_WAIT_MINUTES, mcpCallTimeoutMinutes - 1) * MINUTE_MS);
}

export function waitWindowMs(asked: unknown, capMs: number = WAIT_IN_ONE_CALL_MS): number {
  const minutes = typeof asked === "number" && Number.isFinite(asked) ? Math.floor(asked) : 0;
  if (minutes < 1) return WAIT_IN_ONE_CALL_MS;
  return Math.max(MINUTE_MS, Math.min(minutes * MINUTE_MS, LONGEST_WAIT_MINUTES * MINUTE_MS, capMs));
}

export function stillRunningTail(output: string): string {
  return output.length > STILL_RUNNING_TAIL_CHARS ? `…${output.slice(-STILL_RUNNING_TAIL_CHARS)}` : output;
}
