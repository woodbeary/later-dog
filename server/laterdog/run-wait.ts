import { WAIT_IN_ONE_CALL_MS } from "./computer-runs.ts";

export const LONGEST_WAIT_MINUTES = 60;
export const PI_TOOL_CALL_MINUTES = 10;
export const STILL_RUNNING_TAIL_CHARS = 2_000;
export const BAD_WAIT_TEXT = `wait_minutes must be a whole number of minutes from 1 to ${LONGEST_WAIT_MINUTES}.`;

const MINUTE_MS = 60_000;
const ERROR_LINE = /\b(?:error|errors|failed|failure|fail|fatal|exception|traceback|panic)\b/i;

export function waitCapMs(driverKind: string | undefined, mcpCallTimeoutMinutes: number): number {
  if (driverKind === "claudeAgent") return LONGEST_WAIT_MINUTES * MINUTE_MS;
  const engineMinutes = driverKind === "piAgent" ? Math.min(PI_TOOL_CALL_MINUTES, mcpCallTimeoutMinutes) : mcpCallTimeoutMinutes;
  return Math.max(WAIT_IN_ONE_CALL_MS, Math.min(LONGEST_WAIT_MINUTES, engineMinutes - 1) * MINUTE_MS);
}

export function waitWindowMs(asked: unknown, capMs: number = WAIT_IN_ONE_CALL_MS): number | null {
  if (asked === undefined || asked === null) return WAIT_IN_ONE_CALL_MS;
  if (typeof asked !== "number" || !Number.isInteger(asked) || asked < 1 || asked > LONGEST_WAIT_MINUTES) return null;
  return Math.max(MINUTE_MS, Math.min(asked * MINUTE_MS, capMs));
}

export function stillRunningTail(output: string): string {
  if (output.length <= STILL_RUNNING_TAIL_CHARS) return output;
  const cut = output.length - STILL_RUNNING_TAIL_CHARS;
  const firstError = output.slice(0, cut).split("\n").find((line) => ERROR_LINE.test(line))?.trim();
  return [
    `(Output shortened to its last ${STILL_RUNNING_TAIL_CHARS.toLocaleString("en-US")} characters while the job runs; the whole end comes back when it finishes.)`,
    ...(firstError ? [`First line that looks like an error: ${firstError.slice(0, 300)}`] : []),
    `…${output.slice(cut)}`,
  ].join("\n");
}
