import type { IncomingMessage, ServerResponse } from "node:http";

import type { json as sendJson } from "../harness/http.ts";
import { droppedAfter, isPersonText, leftInPlace, rewindAction, versionOf, type RewindAction } from "../laterdog/rewind.ts";
import { fromLocalTools, type RequestAuth } from "../request-auth.ts";
import { acceptedSendMatch, parseSendId } from "../send-idempotency.ts";
import type { BotRecord, Message } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface RewindRouteDeps {
  pinned(req: IncomingMessage, auth: RequestAuth, botId: string, threadId: unknown): void;
  bot(botId: string, threadId: unknown): BotRecord;
  refusal(auth: RequestAuth, threadId: string): string | null;
  personText(auth: RequestAuth, bot: BotRecord, typed: string): string;
  localRefusal: string;
  messages(threadId: string): Message[];
  activePath(threadId: string): Message[];
  busy(botId: string, threadId: string): boolean;
  savingSecret(threadId: string): boolean;
  rewindTo(threadId: string, leafId: string): string | null;
  markRewound(botId: string, threadId: string): void;
  rerunRefusal(bot: BotRecord): string | null;
  send(auth: RequestAuth, bot: BotRecord, source: Message, text: string, sendId: string | undefined): Promise<Message | undefined>;
}

export interface RewindAsk {
  botId: string;
  messageId: string;
  action: RewindAction;
  edit: boolean;
}

export async function answerRewind(
  deps: RewindRouteDeps,
  ctx: { req: IncomingMessage; res: ServerResponse; auth: RequestAuth; json: typeof sendJson },
  ask: RewindAsk,
  body: Record<string, unknown>,
): Promise<void> {
  const { req, res, auth, json } = ctx;
  deps.pinned(req, auth, ask.botId, body?.threadId);
  const bot = deps.bot(ask.botId, body.threadId);
  const notYours = deps.refusal(auth, bot.threadId);
  if (notYours) return json(res, 403, { error: notYours });
  const threadMessages = deps.messages(bot.threadId);
  const source = threadMessages.find((msg) => msg.id === ask.messageId);
  const asked = ask.action === "send" ? deps.personText(auth, bot, String(body.text ?? "").trim()) : "";
  if (ask.action === "send" && !asked) return json(res, 400, { error: "text required" });
  if (!source || !isPersonText(source)) {
    return json(res, 404, { error: ask.edit ? "only user messages can be edited" : "only your own messages can be rewound to" });
  }
  if (fromLocalTools(auth) && source.via !== "api") return json(res, 403, { error: deps.localRefusal });
  const text = ask.action === "resend" ? deps.personText(auth, bot, (source.text ?? "").trim()) : asked;
  if (ask.action === "resend" && !text) return json(res, 400, { error: "this message has no text to send again" });
  const notUndone = leftInPlace(droppedAfter(deps.activePath(bot.threadId), source));
  const sendId = ask.action === "hold" ? undefined : parseSendId(typeof body.sendId === "string" ? body.sendId : undefined);
  if (sendId) {
    const accepted = acceptedSendMatch(threadMessages, sendId, text, source.replyToId);
    if (accepted.kind === "conflict" || (accepted.kind === "match" && (accepted.message.parentId ?? null) !== (source.parentId ?? null))) {
      return json(res, 409, { error: "sendId already belongs to another message" });
    }
    if (accepted.kind === "match") {
      return json(res, 202, { ok: true, message: accepted.message, version: versionOf(threadMessages, accepted.message) });
    }
  }
  if (deps.busy(bot.id, bot.threadId)) return json(res, 409, { error: "the thread is working — stop it before editing", code: "thread_busy" });
  if (deps.savingSecret(bot.threadId)) {
    return json(res, 409, { error: "this task is securely saving a credential — try again when it finishes" });
  }
  if (ask.action === "hold") {
    const leaf = source.parentId ? deps.rewindTo(bot.threadId, source.parentId) : null;
    if (!leaf) return json(res, 409, { error: "this is the first message — send it again or send a change instead", code: "first_message" });
    deps.markRewound(bot.id, bot.threadId);
    return json(res, 200, { ok: true, activeLeafId: leaf, draft: source.text ?? "", version: versionOf(threadMessages, source), notUndone });
  }
  const rerunRefusal = deps.rerunRefusal(bot);
  if (rerunRefusal) return json(res, 409, { error: rerunRefusal });
  const message = await deps.send(auth, bot, source, text, sendId);
  return json(res, 202, { ok: true, message, ...(message ? { version: versionOf(deps.messages(bot.threadId), message) } : {}), notUndone });
}

export function createRewindRoutes(deps: RewindRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const m = path.match(/^\/api\/bots\/([\w-]+)\/rewind$/);
    if (!m || method !== "POST") return PASS;
    const body = await readBody(req);
    const action = rewindAction(body?.action);
    if (!action) return json(res, 400, { error: "action must be hold, resend or send" });
    return answerRewind(deps, { req, res, auth, json }, { botId: m[1]!, messageId: String(body?.messageId ?? ""), action, edit: false }, body);
  };
}
