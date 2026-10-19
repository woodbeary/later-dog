import { describe, expect, it } from "vitest";

import { HIDDEN_SECTION_ID, UNASSIGNED_SECTION_ID, userSectionId } from "./sidebar-layout";
import { dogDropChangesSection, sectionForDogDrop } from "./section-drop";

describe("dropping a dog on a section", () => {
  it("moves it into a named section or back to Unassigned", () => {
    expect(sectionForDogDrop(userSectionId("Work"))).toBe("Work");
    expect(sectionForDogDrop(UNASSIGNED_SECTION_ID)).toBe("");
  });

  it("ignores the hidden dogs group", () => {
    expect(sectionForDogDrop(HIDDEN_SECTION_ID)).toBeNull();
  });

  it("changes nothing when the dog is already there", () => {
    expect(dogDropChangesSection("Work", "Work")).toBe(false);
    expect(dogDropChangesSection(undefined, "")).toBe(false);
    expect(dogDropChangesSection(" Work ", "Work")).toBe(false);
    expect(dogDropChangesSection("Work", "")).toBe(true);
    expect(dogDropChangesSection(undefined, "Home")).toBe(true);
    expect(dogDropChangesSection("Work", null)).toBe(false);
  });
});
