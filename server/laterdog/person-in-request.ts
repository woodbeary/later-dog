import type { WireMessage } from "../../shared/wire.ts";

type Row = Pick<WireMessage, "role" | "peerAsk" | "roomRequest">;

export function personInRequest(messages: readonly Row[], requestId: string): boolean {
  let person = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.roomRequest?.phase === "request" && message.roomRequest.id === requestId) return person;
    if (message.role === "user" && !message.peerAsk) person = true;
  }
  return false;
}
