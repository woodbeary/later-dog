import { describe, expect, it } from "vitest";
import { foldSidebarToRail, type SidePanels } from "./sidebar-fold";

const closed: SidePanels = { botOpen: true, settingsOpen: false, cloudTaskOpen: false, workPanelOpen: false };

describe("sidebar fold", () => {
  it("keeps the full sidebar with no side panel open, at any width", () => {
    expect(foldSidebarToRail(closed, false)).toBe(false);
    expect(foldSidebarToRail(closed, true)).toBe(false);
  });

  it("folds to the face rail below 1280 when a dog's settings are open, and not at 1280 or wider", () => {
    expect(foldSidebarToRail({ ...closed, settingsOpen: true }, false)).toBe(true);
    expect(foldSidebarToRail({ ...closed, settingsOpen: true }, true)).toBe(false);
    expect(foldSidebarToRail({ ...closed, botOpen: false, settingsOpen: true }, false)).toBe(false);
  });

  it("folds to the face rail below 1280 when the coding-job panel is open, and not at 1280 or wider", () => {
    expect(foldSidebarToRail({ ...closed, botOpen: false, cloudTaskOpen: true }, false)).toBe(true);
    expect(foldSidebarToRail({ ...closed, botOpen: false, cloudTaskOpen: true }, true)).toBe(false);
  });
});
