export type SpotlightRect = { x: number; y: number; w: number; h: number };
export type SpotlightPlacement = "above" | "below" | "right";

const MARGIN = 12;
const GAP = 12;
const CARD_WIDTH = 320;

export function positionSpotlight(
  target: SpotlightRect | null,
  preferred: SpotlightPlacement,
  viewport: { w: number; h: number },
  measuredHeight: number,
) {
  const width = Math.min(CARD_WIDTH, Math.max(1, viewport.w - MARGIN * 2));
  const maxHeight = Math.max(1, viewport.h - MARGIN * 2);
  const height = Math.min(measuredHeight, maxHeight);
  const fitX = (x: number) => Math.max(MARGIN, Math.min(x, viewport.w - width - MARGIN));
  const fitY = (y: number) => Math.max(MARGIN, Math.min(y, viewport.h - height - MARGIN));
  if (!target) {
    return { x: fitX((viewport.w - width) / 2), y: fitY((viewport.h - height) / 2), width, maxHeight, side: "center" as const };
  }
  const candidates = {
    below: { x: fitX(target.x), y: target.y + target.h + GAP },
    above: { x: fitX(target.x), y: target.y - GAP - height },
    right: { x: target.x + target.w + GAP, y: fitY(target.y + (target.h - height) / 2) },
    left: { x: target.x - GAP - width, y: fitY(target.y + (target.h - height) / 2) },
  };
  const order = preferred === "right" ? ["right", "below", "above", "left"] as const
    : preferred === "below" ? ["below", "above", "right", "left"] as const
      : ["above", "below", "right", "left"] as const;
  for (const side of order) {
    const candidate = candidates[side];
    if (candidate.x >= MARGIN && candidate.x + width <= viewport.w - MARGIN
      && candidate.y >= MARGIN && candidate.y + height <= viewport.h - MARGIN) {
      return { ...candidate, width, maxHeight, side };
    }
  }
  return {
    x: fitX(target.x + target.w - width - GAP * 2),
    y: fitY(target.y + target.h - height - GAP * 2),
    width,
    maxHeight,
    side: "inside" as const,
  };
}
