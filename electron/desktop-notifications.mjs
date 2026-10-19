import { randomUUID } from "node:crypto";

export const NOTIFICATION_OPEN_CHANNEL = "notification:open";
export const NOTIFICATION_REPLY_CHANNEL = "notification:reply";
export const NOTIFY_CHANNEL = "notification:show";

const ID = /^[\w:.-]{1,128}$/;
const MAX_TITLE = 200;
const MAX_BODY = 1_000;
const MAX_REPLY = 20_000;

const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

export function bannerRequest(input) {
  if (!input || typeof input !== "object") return null;
  const { kind, botId, threadId, groupId, title, body } = input;
  if (typeof kind !== "string" || !ID.test(kind)) return null;
  if (typeof botId !== "string" || !ID.test(botId)) return null;
  if (typeof threadId !== "string" || !ID.test(threadId)) return null;
  if (groupId !== undefined && (typeof groupId !== "string" || !ID.test(groupId))) return null;
  const heading = clip(title, MAX_TITLE).trim();
  if (!heading) return null;
  return {
    kind,
    botId,
    threadId,
    ...(groupId ? { groupId } : {}),
    title: heading,
    body: clip(body, MAX_BODY),
    silent: input.silent === true,
    replyable: input.replyable === true,
  };
}

function replyText(details, legacy) {
  const text = typeof details?.reply === "string" ? details.reply : typeof legacy === "string" ? legacy : "";
  return text.trim() ? text.slice(0, MAX_REPLY) : "";
}

export function createDesktopNotifications({
  Notification,
  platform = process.platform,
  open,
  deliver,
  newSendId = randomUUID,
}) {
  const live = new Map();
  const supported = () => typeof Notification?.isSupported !== "function" || Notification.isSupported();

  return {
    show(input) {
      const request = bannerRequest(input);
      if (!request || !supported()) return false;
      const target = {
        botId: request.botId,
        threadId: request.threadId,
        ...(request.groupId ? { groupId: request.groupId } : {}),
      };
      const id = request.kind === "spend" ? "laterdog:spend" : `laterdog:${request.groupId ?? request.botId}`;
      const canReply = platform === "darwin" && request.replyable;
      const banner = new Notification({
        id,
        groupId: request.groupId ?? request.botId,
        title: request.title,
        body: request.body,
        silent: request.silent,
        ...(canReply ? { hasReply: true, replyPlaceholder: "Reply" } : {}),
      });
      const forget = () => {
        if (live.get(id) === banner) live.delete(id);
      };
      banner.on("click", () => {
        forget();
        open(NOTIFICATION_OPEN_CHANNEL, target);
      });
      if (canReply) {
        banner.on("reply", (details, legacy) => {
          forget();
          const text = replyText(details, legacy);
          if (!text) return;
          deliver(NOTIFICATION_REPLY_CHANNEL, { ...target, text, sendId: newSendId() });
        });
      }
      banner.on("close", forget);
      banner.on("failed", forget);
      live.set(id, banner);
      banner.show();
      return true;
    },
    liveCount: () => live.size,
  };
}

export function hideOnClose(win, { platform = process.platform, quitting }) {
  if (platform !== "darwin") return;
  win.on("close", (event) => {
    if (quitting()) return;
    event.preventDefault();
    if (win.isFullScreen?.()) {
      win.once("leave-full-screen", () => win.hide());
      win.setFullScreen(false);
      return;
    }
    win.hide();
  });
}
