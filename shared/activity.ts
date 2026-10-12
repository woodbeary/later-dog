
export type ActivityOutcome =
  | "ran"
  | "failed"
  | "running"
  | "allowed"
  | "denied"
  | "waiting";

export interface ActivityRow {
  at: string;
  threadId: string;
  turnId?: string;
  requestId?: string;
  tool: string;
  app: string | null;
  label: string;
  summary?: string;
  outcome: ActivityOutcome;
}
