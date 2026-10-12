import type { Message } from "@/state/store";

export type PeerDelivery = "ask_bot" | "delegate_bot" | "start_thread";

export interface PeerLine {
  botId?: string;
  name: string;
  delivery: PeerDelivery;
  body: string;
  unattended?: boolean;
}

const PROVENANCE_NOTE =
  /^\[(Message from|Delegated by|Thread opened by) @([^,\]]+), another bot in this (?:later\.dog|Later\.Dog|later.dog) workspace[^\]]*\]\s*/;

const DELIVERY: Record<string, PeerDelivery> = {
  "Message from": "ask_bot",
  "Delegated by": "delegate_bot",
  "Thread opened by": "start_thread",
};

export function peerLine(message: Pick<Message, "role" | "text" | "peerAsk">): PeerLine | null {
  if (message.role !== "user") return null;
  const text = message.text ?? "";
  const note = PROVENANCE_NOTE.exec(text);
  const name = message.peerAsk?.name ?? note?.[2]?.trim();
  if (!name) return null;
  return {
    botId: message.peerAsk?.botId,
    name,
    delivery: (note && DELIVERY[note[1]]) || "ask_bot",
    body: note ? text.slice(note[0].length) : text,
    ...(message.peerAsk?.unattended ? { unattended: true } : {}),
  };
}
