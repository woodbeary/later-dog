import type { Message } from "../store.ts";
import { reactedText, tapbackEmoji, tapbackTarget, tapbackTurnKey, withTapback } from "../laterdog/tapback.ts";
import type { InternalRouteHandler } from "./internal.ts";
import { PASS } from "./table.ts";

export const REACT_PATH = "/api/internal/react";

export interface ReactRouteDeps {
  activePath(threadId: string): ReadonlyArray<Message>;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
  liveTurn(threadId: string): string | undefined;
  reactedTurns: Set<string>;
  pendingTapbackText: Map<string, string>;
  active(capability: unknown): boolean;
}

export function createReactRoute(deps: ReactRouteDeps): InternalRouteHandler {
  return async ({ res, path, method, json, sender, threadId, capability, readBody }) => {
    if (method !== "POST" || path !== REACT_PATH) return PASS;
    const body = await readBody();
    const emoji = tapbackEmoji(body.emoji);
    if (!emoji) return json(res, 400, { error: "react needs one emoji, for example 👍." });
    const messageId = typeof body.messageId === "string" && body.messageId.trim() ? body.messageId.trim() : undefined;
    const target = tapbackTarget(deps.activePath(threadId), messageId);
    if (!target) return json(res, 404, { error: messageId ? "No message with that id in this chat." : "There is no message from the person in this chat to react to." });
    if (!deps.active(capability)) throw Object.assign(new Error("the internal turn capability has expired"), { status: 401 });
    const patched = deps.patchMessage(threadId, target.id, { reactions: withTapback(target.reactions, emoji, sender.id) });
    if (!patched) return json(res, 404, { error: "That message is no longer in this chat." });
    const turnId = deps.liveTurn(threadId);
    if (turnId) {
      const key = tapbackTurnKey(threadId, turnId);
      deps.reactedTurns.add(key);
      if (!deps.pendingTapbackText.has(key)) deps.pendingTapbackText.set(key, "");
    }
    return json(res, 200, { messageId: target.id, emoji, text: reactedText(emoji, target) });
  };
}
