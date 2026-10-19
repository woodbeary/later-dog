import { describe, expect, it } from "vitest";

import { mentionedBots, normalizeGroupDefaultResponder, roomResponders } from "./store.ts";

describe("mentionedBots", () => {
  const peers = [
    { id: "1", name: "New Bot" },
    { id: "2", name: "New Bot 2" },
    { id: "3", name: "Sam" },
    { id: "4", name: "Ghost", hidden: true },
  ];
  it("matches a tag at a word start, case-insensitively", () => {
    expect(mentionedBots("hey @sam, look", peers).map((b) => b.id)).toEqual(["3"]);
    expect(mentionedBots("@Sam first thing", peers).map((b) => b.id)).toEqual(["3"]);
  });
  it("prefers the longest name so prefixes never half-match", () => {
    expect(mentionedBots("ask @New Bot 2 about it", peers).map((b) => b.id)).toEqual(["2"]);
  });
  it("dedupes repeats and collects multiple bots", () => {
    expect(mentionedBots("@Sam and @New Bot and @Sam", peers).map((b) => b.id)).toEqual(["3", "1"]);
  });
  it("ignores emails and mid-word @, and matches a hidden bot like any other", () => {
    expect(mentionedBots("mail sam@sam.dev please", peers)).toEqual([]);
    expect(mentionedBots("@Ghost around?", peers).map((b) => b.id)).toEqual(["4"]);
  });
  it("routes Markdown- and punctuation-wrapped mentions", () => {
    expect(mentionedBots("**@Sam** (@New Bot 2) 【@New Bot】", peers).map((bot) => bot.id))
      .toEqual(["3", "2", "1"]);
    expect(mentionedBots("user@Sam /@Sam", peers)).toEqual([]);
  });
  it("requires a word boundary at the end of the name", () => {
    expect(mentionedBots("ask @New Bottle about it", peers)).toEqual([]);
    expect(mentionedBots("@Samo is someone else", peers)).toEqual([]);
    expect(mentionedBots("@Sam𐐀 is someone else", peers)).toEqual([]);
  });
});

describe("roomResponders", () => {
  const members = [
    { id: "atlas", name: "Atlas" },
    { id: "sam", name: "Sam" },
  ];

  it("routes an unmentioned message to the configured lead", () => {
    expect(roomResponders("hello there", members, { kind: "member", botId: "atlas" })).toEqual([members[0]]);
  });

  it("lets explicit mentions override the configured lead", () => {
    expect(roomResponders("@Sam take this", members, { kind: "member", botId: "atlas" })).toEqual([members[1]]);
  });

  it("supports everyone and mentions-only room policies", () => {
    expect(roomResponders("hello", members, { kind: "everyone" })).toEqual(members);
    expect(roomResponders("hello", members, { kind: "mentions" })).toEqual([]);
    expect(roomResponders("@everyone hello", members, { kind: "mentions" })).toEqual(members);
  });

  it("applies the shared mention boundaries to everyone", () => {
    const mentionsOnly = { kind: "mentions" } as const;
    expect(roomResponders("**@EVERYONE** hello", members, mentionsOnly)).toEqual(members);
    expect(roomResponders("【@everyone】 hello", members, mentionsOnly)).toEqual(members);
    expect(roomResponders("@everyone調査 hello", members, mentionsOnly)).toEqual([]);
    expect(roomResponders("@everyone𐐀 hello", members, mentionsOnly)).toEqual([]);
    expect(roomResponders("user@everyone /@everyone", members, mentionsOnly)).toEqual([]);
  });

  it("keeps bot-to-bot channels on their last-speaker routing", () => {
    expect(normalizeGroupDefaultResponder({ kind: "everyone" }, members.map((member) => member.id), true)).toEqual({
      kind: "mentions",
    });
  });
});
