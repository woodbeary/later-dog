import { describe, expect, it } from "vitest";
import { answerRoomCard, type RoomCard, type RoomCardAnswerFacts } from "./room-card-answer.ts";

const open: RoomCard & Record<string, unknown> = { title: "Which colour?", options: ["Red", "Blue"] };
const facts = (over: Partial<RoomCardAnswerFacts> = {}): RoomCardAnswerFacts => ({
  threadBelongsToRoom: true,
  line: { id: "card-1", card: { ...open } },
  body: { answered: "Red", dismissed: true },
  refusal: null,
  ...over,
});

describe("answering a card in a room", () => {
  it("records the answer and closes the card", () => {
    expect(answerRoomCard(facts())).toEqual({ ok: true, changed: true, card: { ...open, answered: "Red", dismissed: true } });
  });

  it("records who answered when the home knows", () => {
    const answeredBy = { kind: "session", name: "Sam", person: "p_1" } as const;
    expect(answerRoomCard(facts({ answeredBy }))).toMatchObject({ changed: true, card: { answered: "Red", answeredBy } });
  });

  it("changes nothing when the card is already answered, and keeps the first answer", () => {
    const line = { id: "card-1", card: { ...open, answered: "Blue", dismissed: true } };
    expect(answerRoomCard(facts({ line, answeredBy: { kind: "loopback" } }))).toEqual({ ok: true, changed: false, card: line.card });
  });

  it("changes nothing when a dismissal repeats", () => {
    const line = { id: "card-1", card: { ...open, dismissed: true } };
    expect(answerRoomCard(facts({ line, body: { dismissed: true } }))).toMatchObject({ ok: true, changed: false });
  });

  it("dismisses a card without answering it", () => {
    expect(answerRoomCard(facts({ body: { dismissed: true } }))).toEqual({ ok: true, changed: true, card: { ...open, dismissed: true } });
  });

  it.each([
    ["an unknown message", { line: undefined }, 404, "no such message"],
    ["a message that is not a card", { line: { id: "card-1" } }, 404, "that message is not a card"],
    ["a thread that is not the room's", { threadBelongsToRoom: false }, 404, "no such conversation in this room"],
    ["an approval request card", { line: { id: "card-1", card: { ...open, requestId: "r-1" } } }, 409, "request cards must be answered through the approval endpoint"],
    ["someone who may not answer", { refusal: "Only the owner of this Cloud can answer this card." }, 403, "Only the owner of this Cloud can answer this card."],
    ["a body that is not an object", { body: "Red" }, 400, "body must be a JSON object"],
    ["a field that is not allowed", { body: { answered: "Red", text: "x" } }, 400, "only answered and dismissed may be changed"],
    ["an answer that is not text", { body: { answered: 3 } }, 400, "answered must be a string"],
    ["a dismissal that is not true or false", { body: { dismissed: "yes" } }, 400, "dismissed must be true or false"],
  ] as const)("refuses %s", (_name, over, status, error) => {
    expect(answerRoomCard(facts(over as Partial<RoomCardAnswerFacts>))).toEqual({ ok: false, status, error });
  });

  it("lets someone who may not answer still dismiss", () => {
    expect(answerRoomCard(facts({ refusal: "no", body: { dismissed: true } }))).toMatchObject({ ok: true, changed: true });
  });
});
