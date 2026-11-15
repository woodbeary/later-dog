import type { WireMessage } from "../../shared/wire.ts";

type RoomRow = Pick<WireMessage, "kind" | "text" | "digest" | "roomRequest">;

export function inRoomContext(message: RoomRow): boolean {
  return (message.kind === "text" && Boolean(message.text)) || (message.kind === "digest" && Boolean(message.digest)) || message.roomRequest?.phase === "result";
}

export function roomCarries(messages: readonly RoomRow[], window: number): (requestId: string) => boolean {
  const carried = new Set(messages.filter(inRoomContext).slice(-window)
    .flatMap((message) => message.roomRequest?.phase === "result" ? [message.roomRequest.id] : []));
  return (requestId) => carried.has(requestId);
}
