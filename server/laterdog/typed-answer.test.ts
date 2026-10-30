import { describe, expect, it } from "vitest";
import { questionAnswersById, questionAnswersByQuestion } from "../../shared/ask-question.ts";
import { openQuestion, typedReplyAnswer } from "./typed-answer.ts";

const question = (id: string, card: Record<string, unknown>) => ({ id, card: { questionRequest: { questions: [] }, ...card } });

describe("a reply typed while the dog is waiting on its question", () => {
  it("goes to the newest question the dog is still waiting on", () => {
    const messages = [
      question("older", { requestId: "r1" }),
      { id: "text" },
      question("newer", { requestId: "r2" }),
    ];
    expect(openQuestion(messages, () => true)?.id).toBe("newer");
    expect(openQuestion(messages, (requestId) => requestId === "r1")?.id).toBe("older");
  });

  it("never goes to a question that is answered, closed, not waiting, or not a question at all", () => {
    expect(openQuestion([question("answered", { requestId: "r1", answered: "answer" })], () => true)).toBeUndefined();
    expect(openQuestion([question("closed", { requestId: "r2", dismissed: true })], () => true)).toBeUndefined();
    expect(openQuestion([question("stale", { requestId: "r3" })], () => false)).toBeUndefined();
    expect(openQuestion([{ id: "permission", card: { requestId: "r4" } }], () => true)).toBeUndefined();
    expect(openQuestion([question("no-request", {})], () => true)).toBeUndefined();
  });

  it("also goes to a plain question the dog asked with choices, but never to an approval", () => {
    expect(openQuestion([{ id: "ask", card: { requestId: "r5", requestType: "question" } }], () => true)?.id).toBe("ask");
    expect(openQuestion([{ id: "approval", card: { requestId: "r6", requestType: "permission" } }], () => true)).toBeUndefined();
  });

  it("tells the dog the person typed instead of picking, and to reply now", () => {
    const answer = typedReplyAnswer("Can you plan my trip to Lisbon?");
    expect(answer).toContain("Can you plan my trip to Lisbon?");
    expect(answer).toMatch(/instead of picking an option/);
    expect(answer).toMatch(/reply to it now/);
  });

  it("lands under the first question when the dog asked several, so no engine drops it", () => {
    const asked = [
      { question: "Ship today?", options: [{ label: "Yes" }, { label: "No" }] },
      { question: "Who reviews?", options: [{ label: "Ada" }, { label: "Lin" }] },
    ];
    const typed = "Hold off, Lin is out this week.";
    const words = typedReplyAnswer(typed);
    const answer = typedReplyAnswer(typed, asked);
    expect(questionAnswersById(answer, asked.map((question, index) => ({ id: `q${index}`, question })))).toEqual({ q0: words });
    expect(questionAnswersByQuestion(answer, asked)).toEqual({ "Ship today?": words });
    expect(questionAnswersByQuestion(typedReplyAnswer(typed, [asked[0]!]), [asked[0]!])).toEqual({ "Ship today?": words });
  });
});
