import { describe, expect, it } from "vitest";

import { BOTS_SECTION_ID, CHANNELS_SECTION_ID, PINNED_SECTION_ID, userSectionId } from "./sidebar-layout";
import { dogDropChangesSection, sectionForDogDrop } from "./section-drop";

describe("dropping a dog on a section", () => {
  it("moves it into a named section or back to Unassigned", () => {
    expect(sectionForDogDrop(userSectionId("Work"))).toBe("Work");
    expect(sectionForDogDrop(BOTS_SECTION_ID)).toBe("");
  });

  it("ignores the pinned and group chat sections", () => {
    expect(sectionForDogDrop(PINNED_SECTION_ID)).toBeNull();
    expect(sectionForDogDrop(CHANNELS_SECTION_ID)).toBeNull();
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
