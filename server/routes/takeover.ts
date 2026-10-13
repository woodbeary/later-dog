import { isOpenTakeover, type TakeoverPlace, type TakeoverRequestCardData } from "../../shared/takeover.ts";
import { parseTakeoverInput, takeoverNeedsComputerText, type TakeoverCards, type TakeoverWait } from "../laterdog/takeover.ts";
import type { BotRecord, Store } from "../store.ts";
import { surfaceLabel } from "../surface.ts";
import type { InternalRouteHandler } from "./internal.ts";
import { PASS, type RouteHandler } from "./table.ts";

interface Room {
  id: string;
  name: string;
}

export interface TakeoverRouteDeps {
  bot(id: string): BotRecord | null;
  cards: TakeoverCards;
  controlKey(bot: BotRecord): string;
  computerChanging(bot: BotRecord, controlKey: string): boolean;
  restateHelp(controlKey: string, step: string): { held: boolean; requestId: string };
  waitFor(controlKey: string, wait: TakeoverWait): void;
  take(controlKey: string): void;
  end(wait: TakeoverWait, outcome: "done" | "skipped", controlKey: string): TakeoverRequestCardData | null;
}

export interface TakeoverRequestRouteDeps {
  owner(botId: string, threadId: string): { group?: Room } | null;
  place(sender: BotRecord, threadId: string): TakeoverPlace | "off" | undefined;
  controlKey(bot: BotRecord): string;
  restateHelp(controlKey: string, step: string): { held: boolean; requestId: string };
  messages: Pick<Store, "activePath" | "patchMessage" | "appendMessage">;
  waitFor(controlKey: string, wait: TakeoverWait): void;
  notify(sender: BotRecord, threadId: string, detail: string, room: Room | undefined): void;
}

export function createTakeoverRoutes(deps: TakeoverRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const m = path.match(/^\/api\/bots\/([\w-]+)\/takeover-cards\/([\w-]+)\/(take|done|skip)$/);
    if (!m || method !== "POST") return PASS;
    const body = await readBody(req);
    const wait: TakeoverWait = { botId: m[1]!, threadId: String(body?.threadId ?? ""), messageId: m[2]! };
    const bot = deps.bot(wait.botId);
    const card = deps.cards.read(wait);
    if (!bot || !card) return json(res, 404, { error: "no such take-over request" });
    const controlKey = deps.controlKey(bot);
    if (m[3] !== "take") {
      const ended = deps.end(wait, m[3] === "done" ? "done" : "skipped", controlKey);
      return json(res, 200, { status: ended?.status ?? deps.cards.read(wait)?.status ?? card.status });
    }
    if (!isOpenTakeover(card.status)) return json(res, 409, { error: "this request already ended" });
    if (deps.computerChanging(bot, controlKey)) {
      return json(res, 409, { error: "this bot's cloud computer is being changed — wait before taking control" });
    }
    const { requestId } = deps.restateHelp(controlKey, card.step);
    if (requestId !== card.helpRequestId) deps.cards.write(wait, { ...card, helpRequestId: requestId });
    deps.waitFor(controlKey, wait);
    deps.take(controlKey);
    return json(res, 200, { status: deps.cards.read(wait)?.status ?? card.status });
  };
}

export function createTakeoverRequestRoute(deps: TakeoverRequestRouteDeps): InternalRouteHandler {
  return async ({ res, path, method, json, sender, threadId, readBody }) => {
    if (method !== "POST" || path !== "/api/internal/request-takeover") return PASS;
    const body = await readBody();
    const owner = deps.owner(sender.id, threadId);
    if (!owner) return json(res, 403, { error: "source conversation does not belong to sender" });
    const input = parseTakeoverInput(body);
    if (!input) return json(res, 400, { error: "request_takeover needs step: what the person should do on your screen, in a few plain words." });
    const place = deps.place(sender, threadId);
    if (!place || place === "off") return json(res, 409, { error: takeoverNeedsComputerText(place === "off") });
    const controlKey = deps.controlKey(sender);
    const { held, requestId } = deps.restateHelp(controlKey, input.step);
    const request: TakeoverRequestCardData = {
      step: input.step,
      reason: input.reason,
      helpRequestId: requestId,
      status: held ? "in-control" : "waiting",
      place,
    };
    const open = deps.messages.activePath(threadId).findLast((message) =>
      message.kind === "options" && message.card?.takeoverRequest && isOpenTakeover(message.card.takeoverRequest.status) &&
      (!owner.group || message.from?.botId === sender.id));
    let messageId: string;
    if (open?.card) {
      deps.messages.patchMessage(threadId, open.id, { card: { ...open.card, title: input.step, takeoverRequest: request } });
      messageId = open.id;
    } else {
      messageId = deps.messages.appendMessage(threadId, {
        role: "bot",
        kind: "options",
        ...(owner.group ? { from: { botId: sender.id, name: sender.name, color: sender.color } } : {}),
        card: { title: input.step, subtitle: "", options: [], takeoverRequest: request },
      }).id;
      deps.notify(sender, threadId, `${input.step} on ${surfaceLabel(place)}`, owner.group ? { id: owner.group.id, name: owner.group.name } : undefined);
    }
    deps.waitFor(controlKey, { botId: sender.id, threadId, messageId });
    return json(res, 201, { messageId, status: request.status });
  };
}
