import { WAIT_IN_ONE_CALL_MS } from "./computer-runs.ts";

export const LONGEST_WAIT_MINUTES = 60;
export const STILL_RUNNING_TAIL_CHARS = 2_000;
export const BAD_WAIT_TEXT = `wait_minutes must be a whole number of minutes from 1 to ${LONGEST_WAIT_MINUTES}.`;

const MINUTE_MS = 60_000;

export function waitCapMs(driverKind: string | undefined, mcpCallTimeoutMinutes: number): number {
  if (driverKind === "claudeAgent") return LONGEST_WAIT_MINUTES * MINUTE_MS;
  return Math.max(WAIT_IN_ONE_CALL_MS, Math.min(LONGEST_WAIT_MINUTES, mcpCallTimeoutMinutes - 1) * MINUTE_MS);
}

export function waitWindowMs(asked: unknown, capMs: number = WAIT_IN_ONE_CALL_MS): number | null {
  if (asked === undefined || asked === null) return WAIT_IN_ONE_CALL_MS;
  if (typeof asked !== "number" || !Number.isInteger(asked) || asked < 1 || asked > LONGEST_WAIT_MINUTES) return null;
  return Math.max(MINUTE_MS, Math.min(asked * MINUTE_MS, capMs));
}

export function stillRunningTail(output: string): string {
  return output.length > STILL_RUNNING_TAIL_CHARS ? `…${output.slice(-STILL_RUNNING_TAIL_CHARS)}` : output;
}
