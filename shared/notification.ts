export type NotifyKind =
  | "approval"
  | "question"
  | "done"
  | "routine-failed"
  | "routine-deferred"
  | "turn-failed"
  | "incident"
  | "takeover"
  | "delegation-settled"
  | "spend";

export interface Notification {
  kind: NotifyKind;
  botId: string;
  botName: string;
  threadId: string;
  title: string;
  body: string;
  avatarUrl?: string;
  groupId?: string;
  requestId?: string;
}

