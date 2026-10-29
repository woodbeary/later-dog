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
  | "spend"
  | "phone";

export interface Notification {
  kind: NotifyKind;
  botId: string;
  botName: string;
  threadId: string;
  title: string;
  body: string;
  avatarUrl?: string;
  groupId?: string;
}


const NOT_REPLYABLE: ReadonlySet<NotifyKind> = new Set<NotifyKind>(["approval", "takeover", "phone"]);

export function replyable(kind: NotifyKind): boolean {
  return !NOT_REPLYABLE.has(kind);
}
