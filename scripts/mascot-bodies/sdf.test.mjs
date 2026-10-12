import { describe, expect, it } from "vitest";

import { maskFromPolylines } from "./raster.ts";
import { fieldFromMask, largestInscribedCircle, sampleSdf } from "./sdf.ts";

const FACE_BOX = 228.541;
const SIZE = 256;

const circle = (r, steps = 512) => {
  const c = FACE_BOX / 2;
  const points = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    points.push([c + Math.cos(a) * r, c + Math.sin(a) * r]);
  }
  return [points];
};

const fieldFor = (r) => fieldFromMask(maskFromPolylines(circle(r), SIZE), SIZE);

describe("sdf", () => {
  it("is positive inside, negative outside, and zero on the edge", () => {
    const sdf = fieldFor(80);
    const c = FACE_BOX / 2;
    expect(sampleSdf(sdf, c, c)).toBeGreaterThan(70);
    expect(sampleSdf(sdf, c + 100, c)).toBeLessThan(0);
    expect(Math.abs(sampleSdf(sdf, c + 80, c))).toBeLessThan(3);
  });

  it("finds the centre of a circle as its largest inscribed circle", () => {
    const found = largestInscribedCircle(fieldFor(80));
    expect(found.x).toBeCloseTo(FACE_BOX / 2, 0);
    expect(found.y).toBeCloseTo(FACE_BOX / 2, 0);

    expect(found.radius).toBeGreaterThan(79);
    expect(found.radius).toBeLessThanOrEqual(80);
  });
});
