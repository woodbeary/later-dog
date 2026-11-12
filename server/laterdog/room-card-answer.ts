import type { CardAnswerer } from "../../shared/wire.ts";

export interface RoomCard {
  requestId?: string;
  answered?: string;
  dismissed?: boolean;
  answeredBy?: CardAnswerer;
}

export interface RoomCardLine<Card extends RoomCard = RoomCard> {
  id: string;
  card?: Card;
}

export interface RoomCardAnswerFacts<Card extends RoomCard = RoomCard> {
  threadBelongsToRoom: boolean;
  line: RoomCardLine<Card> | undefined;
  body: unknown;
  refusal: string | null;
  answeredBy?: CardAnswerer;
}

export type RoomCardAnswer<Card extends RoomCard = RoomCard> =
  | { ok: true; changed: false; card: Card }
  | { ok: true; changed: true; card: Card }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

const refuse = (status: 400 | 403 | 404 | 409, error: string): { ok: false; status: 400 | 403 | 404 | 409; error: string } => ({ ok: false, status, error });

export function answerRoomCard<Card extends RoomCard>(facts: RoomCardAnswerFacts<Card>): RoomCardAnswer<Card> | { ok: false; status: 400 | 403 | 404 | 409; error: string } {
  const { body, line } = facts;
  if (!body || typeof body !== "object" || Array.isArray(body)) return refuse(400, "body must be a JSON object");
  const fields = body as Record<string, unknown>;
  if (!facts.threadBelongsToRoom) return refuse(404, "no such conversation in this room");
  if (!line) return refuse(404, "no such message");
  if (!line.card) return refuse(404, "that message is not a card");
  if (line.card.requestId) return refuse(409, "request cards must be answered through the approval endpoint");
  if (fields.answered !== undefined && facts.refusal) return refuse(403, facts.refusal);
  if (Object.keys(fields).some((key) => key !== "answered" && key !== "dismissed" && key !== "threadId")) {
    return refuse(400, "only answered and dismissed may be changed");
  }
  if (fields.answered !== undefined && typeof fields.answered !== "string") return refuse(400, "answered must be a string");
  if (fields.dismissed !== undefined && typeof fields.dismissed !== "boolean") return refuse(400, "dismissed must be true or false");
  const card = line.card;
  const answers = typeof fields.answered === "string" && !card.answered;
  const dismisses = typeof fields.dismissed === "boolean" && fields.dismissed !== Boolean(card.dismissed);
  if (!answers && !dismisses) return { ok: true, changed: false, card };
  return {
    ok: true,
    changed: true,
    card: {
      ...card,
      ...(answers ? { answered: fields.answered as string, ...(facts.answeredBy ? { answeredBy: facts.answeredBy } : {}) } : {}),
      ...(dismisses ? { dismissed: fields.dismissed as boolean } : {}),
    },
  };
}
