import { describe, expect, it } from "vitest";
import { mentionChoicesForQuery, mentionRanges } from "./mentions";

const peers = [{ name: "Atlas" }, { name: "New Bot" }, { name: "New Bot 2" }, { name: "調査担当" }, { name: "Hidden", hidden: true }];
const matches = (text: string, everyone = false) => mentionRanges(text, peers, everyone).map(({ start, end }) => text.slice(start, end));

describe("mention display ranges", () => {
  it("keeps original casing, duplicate occurrences and longest names", () => {
    expect(matches("@ATLAS, ask @New Bot 2 and @Atlas.")).toEqual(["@ATLAS", "@New Bot 2", "@Atlas"]);
  });
  it("supports multiline Unicode text without changing original offsets", () => {
    expect(matches("İ 😀 message\n@調査担当 確認して\n@Atlas")).toEqual(["@調査担当", "@Atlas"]);
  });
  it("ignores emails, unknown/hidden bots, partial names and longer words", () => {
    expect(matches("mail me@Atlas.test @Ghost @Hidden @Atl @Atlas2 @New Bottle https://host/@Atlas")).toEqual([]);
  });
  it("accepts Markdown and opening punctuation boundaries", () => {
    expect(matches("**@Atlas** (@New Bot 2) 【@調査担当】")).toEqual(["@Atlas", "@New Bot 2", "@調査担当"]);
    expect(matches("user@Atlas /@Atlas")).toEqual([]);
  });
  it("only decorates everyone in channels and rejects longer words", () => {
    expect(matches("@everyone @Everyone! @everyone_else @everyone2", true)).toEqual(["@everyone", "@Everyone"]);
    expect(matches("@everyone")).toEqual([]);
  });
  it("rejects Unicode letters, numbers, combining marks and underscores after names", () => {
    expect(matches("@調査担当者 @everyone調査 @Atlasé @Atlas２ @Atlas𐐀 @Atlas𝟙 @Atlas\u0301 @Atlas_else", true)).toEqual([]);
    expect(matches("@everyoneé @everyone２ @everyone𐐀 @everyone𝟙 @everyone\u0301", true)).toEqual([]);
    expect(matches("@調査担当、 @Atlas! @everyone。 @Atlas😀", true)).toEqual(["@調査担当", "@Atlas", "@everyone", "@Atlas"]);
    const text = "@調査担当者 @everyone調査";
    expect(mentionRanges(text, [{ name: "調査担当" }, { name: "調査担当者" }, { name: "everyone調査" }], true))
      .toEqual([{ start: 0, end: 6 }, { start: 7, end: 18 }]);
  });
  it("does not interpret names as regular expressions or HTML", () => {
    const text = "@A+B and @<img>";
    expect(mentionRanges(text, [{ name: "A+B" }, { name: "<img>" }])).toEqual([{ start: 0, end: 4 }, { start: 9, end: 15 }]);
  });
});

describe("mention picker choices", () => {
  const choices = ["everyone", "One", "Two", "Three", "Four", "Five", "Six"]
    .map((name, index) => ({ id: String(index), name }));

  it("keeps every room member instead of truncating after everyone plus five bots", () => {
    expect(mentionChoicesForQuery(choices, "")).toEqual(choices);
  });

  it("filters before display and closes after a completed exact tag", () => {
    expect(mentionChoicesForQuery(choices, "si").map((choice) => choice.name)).toEqual(["Six"]);
    expect(mentionChoicesForQuery(choices, "Six ")).toEqual([]);
  });
});

describe("mentions follow a renamed dog", () => {
  const scout = { id: "d1", name: "Scout", formerNames: ["Pixel"], color: "red" as const };
  const peers = [scout, { id: "d2", name: "Atlas", color: "blue" as const }];

  it("finds a mention written with an earlier name and shows the current one", () => {
    const text = "Ask @Pixel and @Atlas";
    const ranges = mentionRanges(text, peers);
    expect(ranges.map(({ start, end }) => text.slice(start, end))).toEqual(["@Pixel", "@Atlas"]);
    expect(ranges[0]).toMatchObject({ botId: "d1", display: "@Scout", dog: "red" });
    expect(ranges[1]!.display).toBeUndefined();
    expect(ranges[1]).toMatchObject({ botId: "d2" });
  });

  it("lets a current name win over another dog's earlier name", () => {
    const text = "@Pixel";
    const ranges = mentionRanges(text, [...peers, { id: "d3", name: "Pixel" }]);
    expect(ranges).toEqual([{ start: 0, end: 6, botId: "d3" }]);
  });

  it("ignores an earlier name two dogs once shared", () => {
    const both = [
      { id: "a", name: "Ada", formerNames: ["Max"] },
      { id: "b", name: "Ben", formerNames: ["max"] },
    ];
    expect(mentionRanges("@Max", both)).toEqual([]);
  });

  it("does not match an earlier name as the start of a longer word", () => {
    expect(mentionRanges("@Pixelated", peers)).toEqual([]);
  });
});


describe("historical mention identity", () => {
  it("leaves a reused name plain instead of attributing an old message to its new owner", () => {
    const peers = [
      { id: "original", name: "Scout", formerNames: ["Pixel"] },
      { id: "replacement", name: "Pixel" },
    ];
    expect(mentionRanges("Ask @Pixel", peers, false, true)).toEqual([]);
    expect(mentionRanges("Ask @Pixel", peers)).toEqual([{ start: 4, end: 10, botId: "replacement" }]);
    expect(mentionChoicesForQuery(peers, "Pixel")).toEqual([peers[1]]);
  });

  it("does not choose among duplicate current names or fall back to a shorter prefix", () => {
    const peers = [
      { id: "a", name: "New Bot" }, { id: "b", name: "new bot" }, { id: "c", name: "New" },
    ];
    expect(mentionRanges("@New Bot is here", peers, false, true)).toEqual([]);
  });

  it("does not claim an ambiguous alias when its other owner is hidden", () => {
    const peers = [
      { id: "a", name: "Scout", formerNames: ["Pixel"] },
      { id: "b", name: "Pixel", hidden: true },
    ];
    expect(mentionRanges("@Pixel", peers, false, true)).toEqual([]);
  });

  it("keeps a dog's own name as itself in its own chat when another dog once had that name", () => {
    const peers = [
      { id: "scout", name: "Scout", self: true },
      { id: "atlas", name: "Atlas", formerNames: ["Scout"], color: "blue" as const },
    ];
    expect(mentionRanges("Hi @Scout", peers, false, true)).toEqual([]);
    expect(mentionRanges("Hi @Scout", peers)).toEqual([]);
    expect(mentionRanges("@Atlas and @Scout", peers, false, true)).toEqual([{ start: 0, end: 6, botId: "atlas", color: expect.any(String), dog: "blue" }]);
  });

  it("still lets another dog's current name win over the own dog's former name", () => {
    const peers = [
      { id: "scout", name: "Scout", formerNames: ["Pixel"], self: true },
      { id: "pixel", name: "Pixel" },
    ];
    expect(mentionRanges("@Pixel", peers)).toEqual([{ start: 0, end: 6, botId: "pixel" }]);
  });

  it("still displays an unambiguous old name as the renamed bot", () => {
    expect(mentionRanges("@Pixel", [{ id: "a", name: "Scout", formerNames: ["Pixel"] }], false, true))
      .toEqual([{ start: 0, end: 6, botId: "a", display: "@Scout" }]);
  });
});
