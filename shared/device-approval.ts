export const DEVICE_APPROVAL_STATUSES = ["waiting", "approved", "expired", "ended"] as const;
export type DeviceApprovalStatus = (typeof DEVICE_APPROVAL_STATUSES)[number];
export type DeviceApprovalWatch = "check" | "process" | "expiry";
export type DeviceApprovalEndedBy = "check" | "process" | "person" | "expiry" | "dismissed" | "reply" | "replaced";

export interface DeviceApprovalCardData {
  version: 1;
  service: string;
  url: string;
  code?: string;
  expiresAt: number;
  status: DeviceApprovalStatus;
  watching: DeviceApprovalWatch;
  endedBy?: DeviceApprovalEndedBy;
}

export function isOpenDeviceApproval(card: Pick<DeviceApprovalCardData, "status">): boolean {
  return card.status === "waiting";
}

export function shownDeviceApprovalStatus(card: Pick<DeviceApprovalCardData, "status" | "expiresAt">, now: number): DeviceApprovalStatus {
  return card.status === "waiting" && card.expiresAt <= now ? "expired" : card.status;
}

export function deviceApprovalActionPath(botId: string, messageId: string, action: "done" | "dismiss"): string {
  return `/api/bots/${encodeURIComponent(botId)}/device-approvals/${encodeURIComponent(messageId)}/${action}`;
}
