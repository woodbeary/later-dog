import type { WireMessage as Message } from "../../shared/wire.ts";

export const ENDED_REQUEST = { requestPending: false, requestCancelled: true } as const satisfies Partial<Message>;

export function endedRequestIds(messages: readonly Message[], liveRequestId: string | undefined): string[] {
  return messages.filter(message => message.role === "user" && message.requestPending === true && message.id !== liveRequestId)
    .map(message => message.id);
}
