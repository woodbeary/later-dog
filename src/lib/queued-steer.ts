import type { Message } from "@/state/store";

export const STILL_QUEUED_LINE = "Your message is still queued. It will be sent when this turn ends.";

export type QueuedSteerResult =
  | { delivered: true; threadId: string | null; messages: Message[]; queueIds: string[] }
  | { delivered: false; line: string };

export function queuedSteerResult(body: unknown): QueuedSteerResult {
  const reply = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (reply.steered === true || reply.sent === true) {
    return {
      delivered: true,
      threadId: typeof reply.threadId === "string" ? reply.threadId : null,
      messages: Array.isArray(reply.messages) ? reply.messages as Message[] : [],
      queueIds: Array.isArray(reply.queueIds)
        ? reply.queueIds.filter((queueId): queueId is string => typeof queueId === "string")
        : [],
    };
  }
  const reason = typeof reply.reason === "string" ? reply.reason.trim() : "";
  return { delivered: false, line: reason || STILL_QUEUED_LINE };
}
