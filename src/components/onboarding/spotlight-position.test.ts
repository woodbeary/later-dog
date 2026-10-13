import { describe, expect, it } from "vitest";
import { positionSpotlight, type SpotlightRect } from "./spotlight-position";

const overlaps = (a: SpotlightRect, b: SpotlightRect) => a.x < b.x + b.w && a.x + a.w > b.x
  && a.y < b.y + b.h && a.y + a.h > b.y;

describe("tour card placement", () => {
  it("keeps a cramped Apps dialog's search, filters and close button clear", () => {
    const panel = { x: 80, y: 24, w: 1120, h: 752 };
    const header = { x: 80, y: 24, w: 1120, h: 190 };
    const position = positionSpotlight(panel, "below", { w: 1280, h: 800 }, 168);
    expect(position.side).toBe("inside");
    expect(overlaps({ ...position, w: position.width, h: 168 }, header)).toBe(false);
    expect(position.y + 168).toBeLessThanOrEqual(panel.y + panel.h);
  });

  it("uses the measured height to move longer copy above the target", () => {
    const target = { x: 200, y: 350, w: 240, h: 80 };
    const viewport = { w: 800, h: 600 };
    expect(positionSpotlight(target, "below", viewport, 140).side).toBe("below");
    const position = positionSpotlight(target, "below", viewport, 260);
    expect(position.side).toBe("above");
    expect(position.y + 260).toBeLessThan(target.y);
    expect(overlaps({ ...position, w: position.width, h: 260 }, target)).toBe(false);
  });

  it("places a sidebar hint beside the control when it fits", () => {
    const target = { x: 12, y: 300, w: 180, h: 40 };
    const position = positionSpotlight(target, "right", { w: 1024, h: 768 }, 200);
    expect(position.side).toBe("right");
    expect(position.x).toBeGreaterThan(target.x + target.w);
    expect(position.y + 100).toBe(target.y + target.h / 2);
  });

  it("uses available space to the left before covering a tall target", () => {
    const target = { x: 800, y: 12, w: 200, h: 744 };
    const position = positionSpotlight(target, "right", { w: 1024, h: 768 }, 200);
    expect(position.side).toBe("left");
    expect(position.x + position.width).toBeLessThan(target.x);
  });

  it("keeps narrow-screen cards bounded and makes oversized copy scrollable", () => {
    const viewport = { w: 280, h: 300 };
    const position = positionSpotlight({ x: -8, y: -8, w: 296, h: 316 }, "below", viewport, 500);
    expect(position.width).toBe(256);
    expect(position.maxHeight).toBe(276);
    expect(position.x).toBe(12);
    expect(position.y).toBe(12);
  });

  it("keeps cards in view for clipped anchors, long text and viewport changes", () => {
    for (const viewport of [{ w: 320, h: 480 }, { w: 800, h: 600 }, { w: 1440, h: 900 }]) {
      for (const height of [80, 180, 350, 1000]) {
        for (const target of [null, { x: -60, y: -30, w: 250, h: 80 }, { x: viewport.w - 180, y: viewport.h - 40, w: 240, h: 70 }]) {
          for (const placement of ["above", "below", "right"] as const) {
            const position = positionSpotlight(target, placement, viewport, height);
            expect(position.x).toBeGreaterThanOrEqual(12);
            expect(position.y).toBeGreaterThanOrEqual(12);
            expect(position.x + position.width).toBeLessThanOrEqual(viewport.w - 12);
            expect(position.y + Math.min(height, position.maxHeight)).toBeLessThanOrEqual(viewport.h - 12);
          }
        }
      }
    }
  });
});
