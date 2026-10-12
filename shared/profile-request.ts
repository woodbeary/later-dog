export const PROFILE_REQUEST_FIELDS = ["name", "title", "description", "soul", "cwd", "notifications", "speakReplies"] as const;
export type ProfileRequestField = (typeof PROFILE_REQUEST_FIELDS)[number];
export type ProfileRequestChanges = Partial<Record<Exclude<ProfileRequestField, "notifications" | "speakReplies">, string>> &
  Partial<Record<"notifications" | "speakReplies", boolean>>;

export interface ProfileRequestCardData {
  version: 1;
  requestId: string;
  botId: string;
  threadId: string;
  targetBotId: string;
  targetName: string;
  createdAt: number;
  reason: string;
  changes: ProfileRequestChanges;
  before: ProfileRequestChanges;
  expectedRevision: string;
  appliedAt?: number;
  undo?: { appliedRevision: string };
}
