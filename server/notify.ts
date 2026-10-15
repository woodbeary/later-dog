
import type { Notification, NotifyKind } from "../shared/notification.ts";
import { markdownPreview } from "../shared/markdown-preview.ts";

export type { Notification, NotifyKind } from "../shared/notification.ts";

export function summarize(text: string, max = 140): string {
  const line = text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export interface NotifyBot {
  id: string;
  name: string;
  threadId: string;
  notifications?: boolean;
}

export interface NotifyRoom {
  id: string;
  name: string;
  threadId: string;
  busyBotId?: string | null;
}

export function blockedTarget(
  bot: NotifyBot,
  room?: NotifyRoom | null,
): { threadId: string; group?: { id: string; name: string } } {
  if (!room || room.busyBotId !== bot.id) return { threadId: bot.threadId };
  return { threadId: room.threadId, group: { id: room.id, name: room.name } };
}

export function buildSpendNotification(
  bot: Pick<NotifyBot, "id" | "name">,
  threadId: string,
  text: { title: string; body: string },
): Notification {
  return { kind: "spend", botId: bot.id, botName: bot.name, threadId, title: text.title, body: summarize(text.body, 200) };
}

export function buildNotification(
  kind: NotifyKind,
  bot: NotifyBot,
  threadId: string,
  detail: string,
  extra?: { avatarUrl?: string; group?: { id: string; name: string }; card?: { requestId: string; threadId: string } },
): Notification | null {
  if (bot.notifications === false) return null;

  const body = summarize(kind === "done" ? markdownPreview(detail) : detail);
  const who = extra?.group ? `${bot.name} in ${extra.group.name}` : bot.name;
  const title =
    kind === "approval"
      ? `${who} needs approval`
      : kind === "question"
        ? `${who} has a question`
        : kind === "takeover"
          ? `${who} needs your hands`
          : kind === "routine-failed"
            ? `${who}'s routine failed`
            : kind === "routine-deferred"
              ? `${who}'s routine is waiting`
            : kind === "turn-failed"
              ? `${who} couldn't start`
              : kind === "incident"
                ? `${who} hit a problem`
                : kind === "delegation-settled"
                  ? `${who} resumed with results`
                  : `${who} finished`;

  if (kind === "done" && !body) return null;

  const notification: Notification = { kind, botId: bot.id, botName: bot.name, threadId, title, body };
  if (extra?.avatarUrl) notification.avatarUrl = extra.avatarUrl;
  if (extra?.group) notification.groupId = extra.group.id;
  if (extra?.card?.requestId && extra.card.threadId === threadId) notification.requestId = extra.card.requestId;
  return notification;
}
