import { describe, expect, it } from "vitest";

import { addDogTitle, droppedDogFile, readDogFile } from "./AddDogSheet";
import { sectionNameTaken } from "./SectionRenameDialog";
import { addedDogsLine } from "./Sidebar";
import { MAX_TEAM_BACKUP_BYTES } from "../../shared/team-backup";

const file = (name: string, text: string, size = text.length) => ({ name, size, text: async () => text });

describe("adding a shared dog", () => {
  it("asks about one dog or several in plain words", () => {
    expect(addDogTitle({ members: [{ name: "Scout", title: "" }] })).toBe("Add this dog?");
    expect(addDogTitle({ members: [{ name: "Scout", title: "" }, { name: "Pepper", title: "" }] })).toBe("Add these 2 dogs?");
  });

  it("reads a dog file, keeps Markdown as text and refuses what it cannot read", async () => {
    await expect(readDogFile(file("scout.laterdog.json", '{"format":"laterdog.package"}'))).resolves.toEqual({ format: "laterdog.package" });
    await expect(readDogFile(file("scout.md", "# Scout"))).resolves.toBe("# Scout");
    await expect(readDogFile(file("scout.json", "{nope"))).rejects.toThrow("That file is not a later.dog dog file.");
    await expect(readDogFile(file("big.json", "{}", MAX_TEAM_BACKUP_BYTES + 1))).rejects.toThrow("That file is over the 50 MB limit.");
  });

  it("only picks up dog files from a drop", () => {
    expect(droppedDogFile([{ name: "photo.png" }, { name: "scout-1.0.0.laterdog.json" }])).toBe(1);
    expect(droppedDogFile([{ name: "Old pack.DOGTEAM.json" }])).toBe(0);
    expect(droppedDogFile([{ name: "notes.md" }, { name: "data.json" }, { name: "photo.png" }])).toBe(-1);
    expect(droppedDogFile(null)).toBe(-1);
  });

  it("says how many dogs arrived and what still needs connecting", () => {
    expect(addedDogsLine({ members: 1 })).toBe("1 dog added");
    expect(addedDogsLine({ members: 3, connections: 2 })).toBe("3 dogs added · Connections to finish in Plugins → MCP servers: 2");
  });
});

describe("renaming a section", () => {
  it("refuses a name another section already uses, ignoring case, but allows its own name", () => {
    expect(sectionNameTaken("work", "Home", ["Work", undefined, "Home"])).toBe(true);
    expect(sectionNameTaken("HOME", "Home", ["Work", "Home"])).toBe(false);
    expect(sectionNameTaken("Garden", "Home", ["Work", "Home"])).toBe(false);
  });
});
