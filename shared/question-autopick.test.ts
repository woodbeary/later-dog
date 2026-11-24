import { describe, expect, it } from "vitest";

import { questionAnswersById, questionAnswersByQuestion, type AskQuestion } from "./ask-question";
import { autoPickedAnswer, QUESTION_AUTOPICK_MS, questionPicks, recommendedOption } from "./question-autopick";

const deploy: AskQuestion = {
  question: "Should I change it to the live https://cloud.later.dog/v1?",
  options: [{ label: "Leave it" }, { label: "Yes, update it (Recommended)" }],
};
const branch: AskQuestion = { question: "Which branch?", options: [{ label: "main" }, { label: "dev" }] };
const notes: AskQuestion = { question: "Anything else I should know?", options: [] };
const card = (questions: AskQuestion[]) => ({ questionRequest: { version: 1 as const, questions }, options: [] });
const waited = { waitedMs: QUESTION_AUTOPICK_MS };

describe("a question nobody answers in time", () => {
  it("waits three minutes", () => {
    expect(QUESTION_AUTOPICK_MS).toBe(3 * 60_000);
  });

  it("picks the option marked Recommended, wherever it sits, and tells the dog it was picked for it", () => {
    expect(recommendedOption(deploy.options)?.label).toBe("Yes, update it (Recommended)");
    expect(recommendedOption([{ label: "Ship it (recommended) " }])?.label).toBe("Ship it (recommended) ");
    const picked = autoPickedAnswer(card([deploy]), [], waited);
    expect(questionAnswersByQuestion(picked.engine, [deploy])).toEqual({
      [deploy.question]: "No answer after 3 min; auto-picked the recommended option: Yes, update it (Recommended)",
    });
    expect(picked.card).toBe(`Q: ${deploy.question}\nA: Yes, update it (Recommended)`);
  });

  it("picks the first option when none is marked", () => {
    expect(autoPickedAnswer({ options: ["main", "dev"] }, [], waited)).toEqual({
      engine: "No answer after 3 min; auto-picked the first option: main",
      card: "main",
    });
    expect(autoPickedAnswer({ options: ["Not now", "Go ahead (Recommended)"] }, [], waited).card).toBe("Go ahead (Recommended)");
  });

  it("tells the dog to keep going on its own judgment when there was nothing to pick", () => {
    expect(autoPickedAnswer({ options: [] }, [], { ...waited, owner: "Robin" })).toEqual({
      engine: "Robin didn't answer in time. Use your best judgment and keep going. They can correct you later.",
      card: "No answer",
    });
    expect(autoPickedAnswer({ options: [] }, [], { ...waited, owner: "  " }).engine)
      .toBe("The person didn't answer in time. Use your best judgment and keep going. They can correct you later.");
  });

  it("keeps the answers the person already picked and fills in only the rest, each on its own", () => {
    const questions = [branch, deploy, notes];
    const picked = autoPickedAnswer(card(questions), [["dev"], [], []], { ...waited, owner: "Robin" });
    expect(questionAnswersById(picked.engine, questions.map((question) => ({ id: question.question, question })))).toEqual({
      [branch.question]: "dev",
      [deploy.question]: "No answer after 3 min; auto-picked the recommended option: Yes, update it (Recommended)",
      [notes.question]: "Robin didn't answer in time. Use your best judgment and keep going. They can correct you later.",
    });
    expect(picked.card).toBe(
      `Q: ${branch.question}\nA: dev\n\nQ: ${deploy.question}\nA: Yes, update it (Recommended)\n\nQ: ${notes.question}\nA: No answer`,
    );
  });

  it("keeps several picks on a multi-select question, and only picks that are options on the card", () => {
    const toppings: AskQuestion = { question: "Which toppings?", multiSelect: true, options: [{ label: "Cheese" }, { label: "Olives" }] };
    expect(autoPickedAnswer(card([toppings]), [["Olives", "Cheese"]], waited).card).toBe(`Q: ${toppings.question}\nA: Olives, Cheese`);
    expect(autoPickedAnswer(card([branch]), [["made up"]], waited).card).toBe(`Q: ${branch.question}\nA: main`);
  });

  it("says how long it waited in plain words", () => {
    expect(autoPickedAnswer({ options: ["main"] }, [], { waitedMs: 2_000 }).engine).toBe("No answer after 2 s; auto-picked the first option: main");
  });

  it("reads the picks a phone sends while the person is still choosing", () => {
    expect(questionPicks([["dev"], []])).toEqual([["dev"], []]);
    expect(questionPicks([[1, " dev ", ""]])).toEqual([["dev"]]);
    expect(questionPicks("dev")).toBeNull();
    expect(questionPicks([["a"], "b"])).toBeNull();
    expect(questionPicks(Array.from({ length: 7 }, () => []))).toBeNull();
  });
});
