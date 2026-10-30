import { describe, expect, it } from "vitest";
import { draftBlock, draftCard, draftsIn, earlierVersion, wordChanges } from "./draft-card";

describe("draft cards", () => {
  it("reads a draft block: a JSON header line, then the text to send", () => {
    expect(draftCard("draft", '{"via":"email","to":["sam@example.com"],"subject":"Lunch Friday?","id":"lunch"}\nHi Sam,\n\nFree Friday?'))
      .toEqual({ kind: "draft", via: "email", to: ["sam@example.com"], cc: [], subject: "Lunch Friday?", id: "lunch", body: "Hi Sam,\n\nFree Friday?" });
    expect(draftCard("draft", "Shipping the new site today.")).toEqual({ kind: "draft", via: "message", to: [], cc: [], body: "Shipping the new site today." });
    expect(draftCard("draft", '{"via":"tweet","to":"@sam, @kim"}\nHello')).toMatchObject({ via: "x", to: ["@sam", "@kim"] });
    expect(draftCard("draft", '{"via":"email"}\n   ')).toBeNull();
    expect(draftCard("json", "{}")).toBeNull();
  });

  it("finds drafts in a reply and the version before a revision", () => {
    const first = 'Here it is:\n\n```draft\n{"via":"x","id":"launch"}\nWe shipped it.\n```';
    const second = '```draft\n{"via":"x","id":"launch"}\nWe shipped the new site today.\n```';
    expect(draftsIn(first).map((card) => card.body)).toEqual(["We shipped it."]);
    expect(earlierVersion([first], draftsIn(second)[0]!)?.body).toBe("We shipped it.");
    expect(earlierVersion([second], draftsIn(second)[0]!)).toBeNull();
    expect(earlierVersion([first], draftCard("draft", "We shipped it.")!)).toBeNull();
  });

  it("marks the words a revision added and took out", () => {
    expect(wordChanges("We shipped it.", "We shipped the new site today.")).toEqual([
      { text: "We shipped ", change: "same" },
      { text: "it.", change: "removed" },
      { text: "the new site today.", change: "added" },
    ]);
    expect(wordChanges("same words", "same words")).toEqual([{ text: "same words", change: "same" }]);
  });

  it("writes an edited draft back as a block the dog can send", () => {
    const card = draftCard("draft", '{"via":"text","to":["Mom"],"id":"late"}\nRunning late')!;
    expect(draftBlock(card, "Running 10 minutes late ")).toBe('```draft\n{"via":"text","to":["Mom"],"id":"late"}\nRunning 10 minutes late\n```');
  });
});
