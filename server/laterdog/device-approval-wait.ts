import type { DeviceApprovalCardData } from "../../shared/device-approval.ts";

export const DEVICE_APPROVAL_UNANSWERED_MAX = 2;

interface PathMessage {
  role: string;
  kind?: string;
  from?: { botId?: string };
  peerAsk?: unknown;
  card?: { deviceApproval?: DeviceApprovalCardData };
}

export type DeviceApprovalHold =
  | { kind: "expired"; card: DeviceApprovalCardData }
  | { kind: "unanswered"; card: DeviceApprovalCardData; count: number };

function personSpoke(message: PathMessage): boolean {
  return message.role === "user" && !message.from?.botId && !message.peerAsk;
}

function ownCard(message: PathMessage, botId: string, group: boolean): DeviceApprovalCardData | undefined {
  const card = message.kind === "options" ? message.card?.deviceApproval : undefined;
  if (!card) return undefined;
  return !group || message.from?.botId === botId ? card : undefined;
}

export function deviceApprovalHold(messages: readonly PathMessage[], botId: string, group: boolean): DeviceApprovalHold | null {
  const cards: DeviceApprovalCardData[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (personSpoke(message)) break;
    const card = ownCard(message, botId, group);
    if (!card) continue;
    if (card.renew === "asked") break;
    cards.push(card);
  }
  const latest = cards[0];
  if (!latest) return null;
  if (latest.status === "expired" && latest.endedBy === "expiry") return { kind: "expired", card: latest };
  if (cards.length >= DEVICE_APPROVAL_UNANSWERED_MAX && latest.status !== "approved") return { kind: "unanswered", card: latest, count: cards.length };
  return null;
}

export function deviceApprovalHeldText(hold: DeviceApprovalHold): string {
  const service = hold.card.service;
  const why = hold.kind === "expired"
    ? `The last ${service} code expired before the person used it, so they are away.`
    : `The person has not used the ${hold.count} ${service} codes already shown.`;
  return [
    why,
    "Do not start another login or ask again.",
    `End this turn now with one short line saying the ${service} sign-in is waiting for them.`,
    "They get a fresh code by tapping Get a new code on the card, or by writing to you, and later.dog wakes you then.",
  ].join(" ");
}

export function deviceApprovalExpiredNotice(card: Pick<DeviceApprovalCardData, "service">): string {
  return `The ${card.service} code expired. Tap Get a new code when you're ready.`;
}

export function deviceApprovalRenewPrompt(card: Pick<DeviceApprovalCardData, "service">): string {
  return `later.dog device sign-in update: the person is back and asked for a fresh ${JSON.stringify(card.service)} code. Start the sign-in again the same way you did before, show the new code on a fresh card, and end the turn.`;
}

export function deviceApprovalNeedsYou(messages: readonly PathMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (personSpoke(message)) return undefined;
    const card = ownCard(message, "", false);
    if (!card) continue;
    const waiting = card.status === "waiting" || (card.status === "expired" && card.endedBy === "expiry" && card.renew !== "asked");
    return waiting ? `Approve the ${card.service} sign-in` : undefined;
  }
  return undefined;
}

export function deviceApprovalRenewable(card: Pick<DeviceApprovalCardData, "status" | "renew">): boolean {
  return card.status === "expired" && card.renew === "offered";
}
