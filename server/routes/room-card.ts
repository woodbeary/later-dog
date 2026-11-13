import type { Message } from "../store.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { CardAnswerer } from "../../shared/wire.ts";
import { answerRoomCard } from "../laterdog/room-card-answer.ts";
import { PASS, type RouteHandler } from "./table.ts";

type Card = NonNullable<Message["card"]>;

const ROOM_CARD_PATH = /^\/api\/groups\/([\w-]+)\/cards\/([\w-]+)$/;

export interface RoomCardRouteDeps {
  room(id: string): { id: string; threadId: string } | undefined;
  threadBelongsToRoom(roomId: string, threadId: string): boolean;
  messages(threadId: string): readonly Message[];
  refusal(auth: RequestAuth): string | null;
  answeredBy(auth: RequestAuth): CardAnswerer | undefined;
  save(threadId: string, messageId: string, card: Card): Message | null;
}

export interface RoomThreads {
  group(id: string): { threadId: string; dm?: boolean } | undefined;
  groupTaskByThread(groupId: string, threadId: string): unknown;
}

export function roomOwnsThread(rooms: RoomThreads): RoomCardRouteDeps["threadBelongsToRoom"] {
  return (id, threadId) => {
    const room = rooms.group(id);
    return Boolean(room && (room.dm ? room.threadId === threadId : rooms.groupTaskByThread(id, threadId)));
  };
}

export function createRoomCardRoutes(deps: RoomCardRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const match = ROOM_CARD_PATH.exec(path);
    if (!match || method !== "PATCH") return PASS;
    const room = deps.room(match[1]!);
    if (!room) return json(res, 404, { error: "no such room" });
    const body = await readBody(req);
    const requested = body && typeof body === "object" ? (body as { threadId?: unknown }).threadId : undefined;
    if (requested !== undefined && (typeof requested !== "string" || !/^[\w-]+$/.test(requested))) {
      return json(res, 400, { error: "threadId must be a task id" });
    }
    const threadId = typeof requested === "string" ? requested : room.threadId;
    const line = deps.messages(threadId).find((message) => message.id === match[2]);
    const outcome = answerRoomCard({
      threadBelongsToRoom: deps.threadBelongsToRoom(room.id, threadId),
      line: line ? { id: line.id, card: line.card } : undefined,
      body,
      refusal: deps.refusal(auth),
      answeredBy: deps.answeredBy(auth),
    });
    if (!outcome.ok) return json(res, outcome.status, { error: outcome.error });
    const message = outcome.changed ? deps.save(threadId, match[2]!, outcome.card) : line;
    return json(res, 200, { message });
  };
}
