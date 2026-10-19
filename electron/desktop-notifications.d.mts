export interface BannerTarget {
  botId: string;
  threadId: string;
  groupId?: string;
}

export interface BannerReply extends BannerTarget {
  text: string;
  sendId: string;
}

export interface BannerRequest extends BannerTarget {
  kind: string;
  title: string;
  body: string;
  silent?: boolean;
  replyable?: boolean;
}

export interface DesktopNotificationsBridge {
  show(request: BannerRequest): void;
  onOpen(callback: (target: BannerTarget) => void): () => void;
  onReply(callback: (reply: BannerReply) => void): () => void;
}

export declare const NOTIFICATION_OPEN_CHANNEL: string;
export declare const NOTIFICATION_REPLY_CHANNEL: string;
export declare const NOTIFY_CHANNEL: string;
export declare function bannerRequest(input: unknown): (Required<Omit<BannerRequest, "groupId">> & { groupId?: string }) | null;
