import type { BotAvatarCrop } from "./bot-avatar.ts";

export const PROFILE_REQUEST_FIELDS = ["name", "title", "description", "soul", "cwd", "notifications", "speakReplies", "avatarUrl", "avatarCrop"] as const;
export type ProfileRequestField = (typeof PROFILE_REQUEST_FIELDS)[number];
export type ProfileRequestChanges = Partial<Record<Exclude<ProfileRequestField, "notifications" | "speakReplies" | "avatarCrop">, string>> &
  Partial<Record<"notifications" | "speakReplies", boolean>> & { avatarCrop?: BotAvatarCrop };

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
