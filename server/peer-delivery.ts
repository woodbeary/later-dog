
import { clip, peerName } from "./peer-roster.ts";

export type PeerDeliveryOutcome = "queued" | "injected" | "failed";

export interface PeerDeliveryReceipt {
  botId: string;
  botName?: string;
  outcome: PeerDeliveryOutcome;
  detail: string;
  taskId?: string;
  requestId?: string;
  threadId?: string;
}

const DETAIL_MAX = 200;

export function peerDeliveryReceipt(receipt: PeerDeliveryReceipt): PeerDeliveryReceipt {
  return {
    botId: receipt.botId,
    ...(receipt.botName ? { botName: receipt.botName } : {}),
    outcome: receipt.outcome,
    detail: clip(receipt.detail, DETAIL_MAX) || "no detail recorded",
    ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
    ...(receipt.requestId ? { requestId: receipt.requestId } : {}),
    ...(receipt.threadId ? { threadId: receipt.threadId } : {}),
  };
}

const named = (receipt: PeerDeliveryReceipt): string =>
  peerName(receipt.botName ?? "") || peerName(receipt.botId) || "teammate";

export function renderPeerDeliveryReceipts(receipts: readonly PeerDeliveryReceipt[]): string {
  if (!receipts.length) return "";
  const line = (receipt: PeerDeliveryReceipt) => `${named(receipt)}: ${receipt.outcome} — ${receipt.detail}`;
  if (receipts.length === 1) return `Delivery to ${line(receipts[0]!)}`;
  return ["Delivery receipts:", ...receipts.map(receipt => `- ${line(receipt)}`)].join("\n");
}
