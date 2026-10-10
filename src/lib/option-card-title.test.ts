import { describe, expect, it } from "vitest";
import { optionCardTitle } from "./option-card-title";

describe("optionCardTitle", () => {
  it("names the dog that asks, like the other question card", () => {
    const card = { title: "Your dog has a question", requestId: "req-1", requestType: "question" as const };
    expect(optionCardTitle(card, "Pepper")).toBe("Pepper has a question");
    expect(optionCardTitle(card)).toBe("Your dog has a question");
  });

  it("keeps the title of an approval or the first-run quiz", () => {
    expect(optionCardTitle({ title: "Approval needed", requestId: "req-2", requestType: "permission" }, "Pepper")).toBe("Approval needed");
    expect(optionCardTitle({ title: "What do you mostly want help with?" }, "Pepper")).toBe("What do you mostly want help with?");
  });
});
