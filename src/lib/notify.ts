import { replyable, type Notification } from "../../shared/notification";
import type { BannerReply, BannerTarget, DesktopNotificationsBridge } from "../../electron/desktop-notifications.mjs";
import { notificationSoundsEnabled } from "./notification-preferences";

export type NotifyFrame = Notification;

export type NotificationTarget = Pick<NotifyFrame, "botId" | "threadId">;

export type { BannerReply, BannerTarget };

export function requestNotificationPermission(): Promise<NotificationPermission> | null {
  if (desktopBanners()) return null;
  if (typeof Notification === "undefined" || Notification.permission !== "default") return null;
  return Notification.requestPermission();
}

export interface NotificationBotIdentity {
  id: string;
  avatarUrl?: string | null;
}

export function buildNotificationOptions(bot: NotificationBotIdentity): NotificationOptions {
  return { tag: `laterdog:${bot.id}`, icon: bot.avatarUrl ?? undefined };
}

export function desktopBanners(): DesktopNotificationsBridge | null {
  if (typeof window === "undefined") return null;
  return window.laterdog?.notifications ?? null;
}

export function showNotification(
  frame: NotifyFrame,
  onOpen: (target: NotificationTarget) => void,
  avatarUrl?: string | null,
  visibleThreadId?: string | null,
) {
  const spend = frame.kind === "spend";
  if (!spend && typeof document !== "undefined" && document.hasFocus() && visibleThreadId === frame.threadId) return;

  const banners = desktopBanners();
  if (banners) {
    banners.show({
      kind: frame.kind,
      botId: frame.botId,
      threadId: frame.threadId,
      ...(frame.groupId ? { groupId: frame.groupId } : {}),
      title: frame.title,
      body: frame.body,
      silent: !notificationSoundsEnabled(),
      replyable: replyable(frame.kind),
    });
    return;
  }

  if (typeof Notification === "undefined") return;
  const open = () => {
    window.focus();
    onOpen({ botId: frame.botId, threadId: frame.threadId });
  };

  if (Notification.permission === "granted") {
    const options: NotificationOptions = {
      body: frame.body,
      ...buildNotificationOptions({ id: frame.botId, avatarUrl }),
      ...(spend ? { tag: "laterdog:spend", icon: undefined } : {}),
      ...(notificationSoundsEnabled() ? {} : { silent: true }),
    };
    new Notification(frame.title, options).onclick = open;
  }
}
