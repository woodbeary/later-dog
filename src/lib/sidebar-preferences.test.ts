import { describe, expect, it, vi } from "vitest";

import {
  SIDEBAR_COLLAPSED_SECTIONS_KEY,
  SIDEBAR_DENSITY_KEY,
  SIDEBAR_PIN_ORDER_KEY,
  SIDEBAR_WIDTH_KEY,
  clampSidebarWidth,
  loadCollapsedSections,
  loadPinOrder,
  loadSidebarDensity,
  loadSidebarWidth,
  parseSidebarDensity,
  saveCollapsedSections,
  savePinOrder,
  saveSidebarDensity,
  saveSidebarWidth,
  toggleCollapsedSection,
} from "./sidebar-preferences";
import { orderPinnedBots, userSectionId } from "./sidebar-layout";

describe("sidebar density preferences", () => {
  it("accepts the two supported layouts and reads stale values, the old compact one included, as comfortable", () => {
    expect(parseSidebarDensity("comfortable")).toBe("comfortable");
    expect(parseSidebarDensity("compact")).toBe("comfortable");
    expect(parseSidebarDensity("icons")).toBe("icons");
    expect(parseSidebarDensity("tiny")).toBe("comfortable");
    expect(parseSidebarDensity(null)).toBe("comfortable");
  });

  it("loads and saves without making storage availability a launch dependency", () => {
    const setItem = vi.fn();
    saveSidebarDensity("icons", { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_DENSITY_KEY, "icons");
    expect(loadSidebarDensity({ getItem: () => "icons" })).toBe("icons");
    expect(loadSidebarDensity({ getItem: () => "compact" })).toBe("comfortable");
    expect(loadSidebarDensity({ getItem: () => { throw new Error("blocked"); } })).toBe("comfortable");
  });
});

describe("sidebar width preference", () => {
  it("keeps the chat usable and rejects invalid saved widths", () => {
    expect(clampSidebarWidth(500, 900)).toBe(480);
    expect(clampSidebarWidth(500, 768)).toBe(448);
    expect(clampSidebarWidth(100, 900)).toBe(240);
    expect(loadSidebarWidth({ getItem: () => "360" })).toBe(360);
    for (const raw of ["NaN", "9999", "-1", "320.5"]) {
      expect(loadSidebarWidth({ getItem: () => raw })).toBeNull();
    }
  });

  it("persists width without requiring local storage", () => {
    const setItem = vi.fn();
    saveSidebarWidth(360, { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_WIDTH_KEY, "360");
    expect(loadSidebarWidth({ getItem: () => { throw new Error("blocked"); } })).toBeNull();
    expect(() => saveSidebarWidth(360, { setItem: () => { throw new Error("blocked"); } })).not.toThrow();
  });
});

describe("sidebar section preferences", () => {
  it("round-trips unique collapsed section ids and the pinned order", () => {
    const collapsedSet = vi.fn();
    saveCollapsedSections(["builtin:pinned", "builtin:pinned", "section:Work"], {
      setItem: collapsedSet,
    });
    expect(collapsedSet).toHaveBeenCalledWith(
      SIDEBAR_COLLAPSED_SECTIONS_KEY,
      JSON.stringify(["builtin:pinned", "section:Work"]),
    );
    expect(
      loadCollapsedSections({
        getItem: () => JSON.stringify(["builtin:pinned", "section:Work"]),
      }),
    ).toEqual(["builtin:pinned", "section:Work"]);

    const orderSet = vi.fn();
    savePinOrder(["section:Work", "builtin:bots"], { setItem: orderSet });
    expect(orderSet).toHaveBeenCalledWith(
      SIDEBAR_PIN_ORDER_KEY,
      JSON.stringify(["section:Work", "builtin:bots"]),
    );
    expect(loadPinOrder({ getItem: () => JSON.stringify(["section:Work", "builtin:bots"]) })).toEqual([
      "section:Work",
      "builtin:bots",
    ]);
  });

  it("ignores malformed storage and toggles ids without mutating the source", () => {
    expect(loadCollapsedSections({ getItem: () => "not-json" })).toEqual([]);
    expect(loadPinOrder({ getItem: () => JSON.stringify({ nope: true }) })).toEqual([]);
    const current = ["section:Work"];
    expect(toggleCollapsedSection(current, "builtin:bots")).toEqual([
      "section:Work",
      "builtin:bots",
    ]);
    expect(toggleCollapsedSection(current, "section:Work")).toEqual([]);
    expect(current).toEqual(["section:Work"]);
  });

  it("supports newlines, caps untrusted arrays, and tolerates blocked storage", () => {
    const withNewline = "section:Line\nBreak";
    expect(loadPinOrder({ getItem: () => JSON.stringify([withNewline]) })).toEqual([withNewline]);

    const oversized = Array.from({ length: 105 }, (_, index) => `section:${index}`);
    expect(loadPinOrder({ getItem: () => JSON.stringify(oversized) })).toHaveLength(100);
    expect(loadPinOrder({ getItem: () => { throw new Error("blocked"); } })).toEqual([]);
    expect(() => savePinOrder(["section:Work"], { setItem: () => { throw new Error("blocked"); } })).not.toThrow();
  });

  it("persists raw section ids with lone surrogates and max-length emoji names", () => {
    const ids = [userSectionId("\ud800"), userSectionId("🧠".repeat(30))];
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    savePinOrder(ids, storage);
    expect(loadPinOrder(storage)).toEqual(ids);
  });
});

describe("pinned grid order", () => {
  it("keeps the main dog first, then the saved order, then newly pinned dogs as they come", () => {
    const pinned = [{ id: "a" }, { id: "b" }, { id: "main", chiefOfStaff: true }, { id: "c" }];
    expect(orderPinnedBots(pinned, ["c", "a"]).map((bot) => bot.id)).toEqual(["main", "c", "a", "b"]);
    expect(orderPinnedBots(pinned, []).map((bot) => bot.id)).toEqual(["main", "a", "b", "c"]);
  });
});
