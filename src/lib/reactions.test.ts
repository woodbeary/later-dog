import { describe, expect, it } from "vitest";
import { EMOJI_CATALOG, QUICK_REACTIONS, myReactions, reactionSummary, searchEmoji, toggledReactions } from "./reactions";

describe("reactions", () => {
  it("offers five quick reactions, all in the catalog search", () => {
    expect(QUICK_REACTIONS).toEqual(["👍", "👎", "❤️", "😂", "🎉"]);
    for (const emoji of QUICK_REACTIONS) expect(searchEmoji(emoji).map((entry) => entry.emoji)).toContain(emoji);
  });

  it("groups reactions by emoji in first-seen order and marks the person's own", () => {
    expect(reactionSummary([
      { emoji: "👍", by: "pepper" },
      { emoji: "❤️", by: "user" },
      { emoji: "👍", by: "user" },
      { emoji: "👍", by: "user" },
    ])).toEqual([
      { emoji: "👍", count: 2, mine: true, by: ["pepper", "user"] },
      { emoji: "❤️", count: 1, mine: true, by: ["user"] },
    ]);
    expect(reactionSummary(undefined)).toEqual([]);
  });

  it("toggles the person's reaction the same way the server does", () => {
    const once = toggledReactions(undefined, "🎉");
    expect(once).toEqual([{ emoji: "🎉", by: "user" }]);
    expect(toggledReactions(once, "🎉")).toBeUndefined();
    expect(toggledReactions([{ emoji: "🎉", by: "pepper" }], "🎉")).toEqual([{ emoji: "🎉", by: "pepper" }, { emoji: "🎉", by: "user" }]);
    expect(myReactions([{ emoji: "🎉", by: "pepper" }, { emoji: "👍", by: "user" }])).toEqual(["👍"]);
  });

  it("finds emoji by word prefix and shows the whole catalog for an empty search", () => {
    expect(searchEmoji("").length).toBe(EMOJI_CATALOG.length);
    expect(searchEmoji("thumb").map((entry) => entry.emoji)).toContain("👍");
    expect(searchEmoji("zzzz-nothing")).toEqual([]);
  });
});
