import { describe, expect, it } from "vitest";
import { exchangeName, FORMER_NAMES_KEPT, formerNamesAfterRename } from "./former-names.ts";

describe("former names", () => {
  it("remembers the name a dog had before a rename", () => {
    expect(formerNamesAfterRename({ name: "Pixel" }, "Scout")).toEqual(["Pixel"]);
  });

  it("puts the newest earlier name first and never repeats one", () => {
    expect(formerNamesAfterRename({ name: "Scout", formerNames: ["Pixel"] }, "Rex")).toEqual(["Scout", "Pixel"]);
    expect(formerNamesAfterRename({ name: "Scout", formerNames: ["Pixel", "scout"] }, "Rex")).toEqual(["Scout", "Pixel"]);
  });

  it("drops the new name from the history when a dog goes back to an old name", () => {
    expect(formerNamesAfterRename({ name: "Scout", formerNames: ["Pixel"] }, "Pixel")).toEqual(["Scout"]);
  });

  it("changes nothing when the name is the same apart from case or spaces", () => {
    expect(formerNamesAfterRename({ name: "Scout" }, "scout ")).toBeUndefined();
    expect(formerNamesAfterRename({ name: "  " }, "Scout")).toBeUndefined();
  });

  it("keeps only the most recent few", () => {
    const names = Array.from({ length: 12 }, (_, i) => `Old${i}`);
    expect(formerNamesAfterRename({ name: "Now", formerNames: names }, "Next")).toHaveLength(FORMER_NAMES_KEPT);
  });

  it("names an exchange after both dogs in order", () => {
    expect(exchangeName({ name: "New Bot" }, { name: "Study Helper" })).toBe("New Bot ⇄ Study Helper");
  });
});
