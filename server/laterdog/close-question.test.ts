import { describe, expect, it, vi } from "vitest";

import { QUESTION_DISMISS_MESSAGE } from "../../shared/ask-question.ts";
import { asksToCloseQuestion, closeQuestion } from "./close-question.ts";

type Card = { requestType?: "question" | "permission"; tool?: string; answered?: string; answeredText?: string; dismissed?: boolean };

function harness(card: Card, settle?: (card: Card) => Card) {
  let stored = card;
  const answer = vi.fn(async (message: string) => {
    if (settle) stored = settle({ ...stored, answeredText: message });
    return settle ? "answered" : "unavailable";
  });
  const save = vi.fn((next: Card) => {
    stored = next;
  });
  return { answer, save, current: () => stored, stored: () => stored };
}

describe("asksToCloseQuestion", () => {
  it("is a close for a question card sent with dismiss or the close note", () => {
    expect(asksToCloseQuestion({ requestType: "question" }, { dismiss: true })).toBe(true);
    expect(asksToCloseQuestion({ requestType: "question" }, { message: QUESTION_DISMISS_MESSAGE })).toBe(true);
  });

  it("is not a close for a real answer or a permission card", () => {
    expect(asksToCloseQuestion({ requestType: "question" }, { message: "README" })).toBe(false);
    expect(asksToCloseQuestion({ requestType: "question" }, null)).toBe(false);
    expect(asksToCloseQuestion({ requestType: "permission", tool: "Bash" }, { dismiss: true })).toBe(false);
  });
});

describe("closeQuestion", () => {
  it("answers an open question with the close note, so the dog stops waiting, and hides it", async () => {
    const io = harness({ requestType: "question" }, (card) => ({ ...card, answered: "answer", dismissed: false }));
    const closed = await closeQuestion(io.current(), io);
    expect(io.answer).toHaveBeenCalledWith(QUESTION_DISMISS_MESSAGE);
    expect(closed).toEqual({ status: 200, body: { ok: true, dismissed: true, outcome: "answered" } });
    expect(io.stored()).toEqual({ requestType: "question", answered: "answer", answeredText: QUESTION_DISMISS_MESSAGE, dismissed: true });
  });

  it("hides a question whose turn already ended without starting a new one", async () => {
    const io = harness({ requestType: "question" });
    const closed = await closeQuestion(io.current(), io);
    expect(io.answer).toHaveBeenCalledTimes(1);
    expect(closed.body).toEqual({ ok: true, dismissed: true, outcome: "unavailable" });
    expect(io.stored()).toEqual({ requestType: "question", answered: "answer", dismissed: true });
  });

  it("hides an answered question without answering it again", async () => {
    const io = harness({ requestType: "question", answered: "answer", answeredText: "README", dismissed: false });
    const closed = await closeQuestion(io.current(), io);
    expect(io.answer).not.toHaveBeenCalled();
    expect(closed.body).toEqual({ ok: true, dismissed: true });
    expect(io.stored()).toEqual({ requestType: "question", answered: "answer", answeredText: "README", dismissed: true });
  });

  it("treats a second close as done", async () => {
    const io = harness({ requestType: "question", answered: "answer", dismissed: true });
    const closed = await closeQuestion(io.current(), io);
    expect(io.answer).not.toHaveBeenCalled();
    expect(io.save).not.toHaveBeenCalled();
    expect(closed.body).toEqual({ ok: true, dismissed: true });
  });
});
