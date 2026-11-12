export type ExchangeStatus = "queued" | "running" | "waiting" | "needs-you" | "completed" | "failed" | "cancelled";

export type ExchangeEnd = "person" | "api" | "interrupted" | "deleted" | "idle" | "capped" | "origin" | "limit" | "restart" | "problem" | "timeout" | "ceiling";

export interface WireExchange {
  id: string;
  status: ExchangeStatus;
  owner: { dog: string; person: boolean };
  from?: string;
  to: string;
  parentId?: string;
  request: string;
  reply?: string;
  endedBy?: ExchangeEnd;
  waitingOn?: string[];
}
