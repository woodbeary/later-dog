import type { BannerReply, BannerRequest, BannerTarget, DesktopNotificationsBridge } from "../../electron/desktop-notifications.mjs";

export interface RecordingBanners {
  shown: BannerRequest[];
  reply(reply: BannerReply): void;
  open(target: BannerTarget): void;
}

declare global {
  interface Window {
    recordingBanners?: RecordingBanners;
  }
}

export function installRecordingBanners(target: Window = window): RecordingBanners {
  const shown: BannerRequest[] = [];
  const replyListeners = new Set<(reply: BannerReply) => void>();
  const openListeners = new Set<(target: BannerTarget) => void>();
  const notifications: DesktopNotificationsBridge = {
    show: (request) => { shown.push(request); },
    onReply: (callback) => {
      replyListeners.add(callback);
      return () => replyListeners.delete(callback);
    },
    onOpen: (callback) => {
      openListeners.add(callback);
      return () => openListeners.delete(callback);
    },
  };
  const recording: RecordingBanners = {
    shown,
    reply: (reply) => { for (const listener of replyListeners) listener(reply); },
    open: (place) => { for (const listener of openListeners) listener(place); },
  };
  target.laterdog = { ...target.laterdog, platform: target.laterdog?.platform ?? "darwin", notifications };
  target.recordingBanners = recording;
  return recording;
}
