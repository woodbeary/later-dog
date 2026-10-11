export const SEND_DELIVERIES = ["steer", "queue", "stop"] as const;

export type SendDelivery = (typeof SEND_DELIVERIES)[number];

export function waitsForTurn(delivery: SendDelivery | undefined): boolean {
  return delivery === "queue" || delivery === "stop";
}
