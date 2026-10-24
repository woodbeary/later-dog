import type { IncomingMessage, ServerResponse } from "node:http";
import type { json } from "../harness/http.ts";
import type { Message, Store } from "../store.ts";
import { DESK_BRAIN_PATH, type DeskDog, type DeskReply } from "./desk-brain.ts";

export type DeskBrainRoute = (req: IncomingMessage, res: ServerResponse, path: string, method: string, send: typeof json) => boolean;

export function createDeskBrainRoute(options: {
  verify: (headers: IncomingMessage["headers"], parts: readonly string[]) => boolean;
  dogs: () => DeskDog[];
  now?: () => number;
}): DeskBrainRoute {
  const now = options.now ?? Date.now;
  return (req, res, path, method, send) => {
    if (path !== DESK_BRAIN_PATH) return false;
    res.setHeader("cache-control", "no-store");
    if (method !== "GET") {
      send(res, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!options.verify(req.headers, ["GET", DESK_BRAIN_PATH])) {
      send(res, 401, { error: "invalid_signature" });
      return true;
    }
    send(res, 200, { at: now(), dogs: options.dogs() });
    return true;
  };
}

export function recordDeskExchange(
  store: Pick<Store, "appendMessage" | "messagesFor">,
  input: {
    threadId: string;
    text: string;
    sendId: string;
    replyToId?: string;
    sender?: Message["sender"];
    reply: DeskReply;
  },
): { ok: true; threadId: string; message: Message } {
  const earlier = store.messagesFor(input.threadId).find((message) => message.role === "user" && message.sendId === input.sendId);
  if (earlier) return { ok: true, threadId: input.threadId, message: earlier };
  const message = store.appendMessage(input.threadId, {
    role: "user",
    kind: "text",
    text: input.text,
    replyToId: input.replyToId,
    sendId: input.sendId,
    sender: input.sender,
  });
  store.appendMessage(input.threadId, { role: "bot", kind: "text", text: input.reply.text, turnId: `desk-${input.sendId}`, turnTerminal: true });
  return { ok: true, threadId: input.threadId, message };
}
