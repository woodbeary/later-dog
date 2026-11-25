import { describe, expect, it } from "vitest";
import { foldSidebarToRail, type SidePanels } from "./sidebar-fold";

const closed: SidePanels = {
  botOpen: true,
  settingsOpen: false,
  cloudTaskOpen: false,
  workPanelOpen: false,
};

describe("sidebar room beside a panel", () => {
  it("leaves the sidebar alone without a panel, at either side of the width boundary", () => {
    expect(foldSidebarToRail(closed, false)).toBe(false);
    expect(foldSidebarToRail(closed, true)).toBe(false);
  });

  it("makes room for the selected dog's work panel below the boundary and unfolds on close", () => {
    expect(foldSidebarToRail({ ...closed, workPanelOpen: true }, false)).toBe(true);
    expect(foldSidebarToRail({ ...closed, workPanelOpen: false }, false)).toBe(false);
    expect(foldSidebarToRail({ ...closed, workPanelOpen: true }, true)).toBe(false);
  });

  it("ignores a work panel when no dog is selected", () => {
    expect(foldSidebarToRail({ ...closed, botOpen: false, workPanelOpen: true }, false)).toBe(
      false,
    );
  });

  it("makes room for a room's work panel while leaving dog settings rules unchanged", () => {
    const room = { ...closed, botOpen: false, roomOpen: true };
    expect(foldSidebarToRail({ ...room, workPanelOpen: true }, false)).toBe(true);
    expect(foldSidebarToRail({ ...room, workPanelOpen: true }, true)).toBe(false);
    expect(foldSidebarToRail({ ...room, settingsOpen: true }, false)).toBe(false);
  });

  it("preserves room for dog settings while keeping a wide sidebar when it fits", () => {
    expect(foldSidebarToRail({ ...closed, settingsOpen: true }, false)).toBe(true);
    expect(foldSidebarToRail({ ...closed, settingsOpen: true }, true)).toBe(false);
    expect(foldSidebarToRail({ ...closed, botOpen: false, settingsOpen: true }, false)).toBe(false);
  });

  it("preserves room for a coding-job panel with or without a selected dog", () => {
    for (const botOpen of [false, true]) {
      expect(foldSidebarToRail({ ...closed, botOpen, cloudTaskOpen: true }, false)).toBe(true);
      expect(foldSidebarToRail({ ...closed, botOpen, cloudTaskOpen: true }, true)).toBe(false);
    }
  });
});
