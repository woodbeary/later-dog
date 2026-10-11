import { describe, expect, it } from "vitest";
import { formatQuestionAnswers } from "../../shared/ask-question";
import { settledAnswer } from "./settled-answer";

const breed = { question: "Which dog breed do you like best?", options: [{ label: "Corgi" }, { label: "Beagle" }] };
const size = { question: "How big?", options: [{ label: "Small" }] };

describe("settledAnswer", () => {
  it("shows only the answer when the card asked one question", () => {
    expect(settledAnswer(formatQuestionAnswers([breed], [["Corgi"]]), [breed])).toBe("Corgi");
    expect(settledAnswer(formatQuestionAnswers([breed], [["Corgi", "Beagle"]]), [breed])).toBe("Corgi, Beagle");
  });

  it("keeps every question beside its answer when the card asked several", () => {
    expect(settledAnswer(formatQuestionAnswers([breed, size], [["Corgi"], ["Small"]]), [breed, size]))
      .toBe("Q: Which dog breed do you like best?\nA: Corgi\n\nQ: How big?\nA: Small");
  });

  it("shows any other answer as it was sent", () => {
    expect(settledAnswer("Corgi please", [breed])).toBe("Corgi please");
    expect(settledAnswer("Q: Something else?\nA: Yes", [breed])).toBe("Q: Something else?\nA: Yes");
  });
});
