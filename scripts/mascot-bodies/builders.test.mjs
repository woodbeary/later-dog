import { describe, expect, it } from "vitest";

import { BODY_DEFS, BODY_IDS } from "./builders.ts";

const EXPECTED_IDS = [
  "dog", "beagle", "shepherd", "corgi", "husky", "pug", "poodle", "chihuahua",
  "blob", "circle", "squircle", "capsule",
  "drop", "shield", "hexagon", "diamond",
];

describe("body builders", () => {
  it("produces the catalog in its persisted order, dog first", () => {
    expect(BODY_IDS).toEqual(EXPECTED_IDS);
  });

  it("emits only absolute M, C and Z, which is all the iOS parser understands", () => {
    for (const body of BODY_DEFS) {
      const commands = body.d.match(/[A-Za-z]/g) ?? [];
      const unique = [...new Set(commands)].sort();
      expect(unique, `${body.id} uses unsupported commands`).toEqual(["C", "M", "Z"]);
    }
  });

  it("starts every outline with a move and closes it", () => {
    for (const body of BODY_DEFS) {
      expect(body.d.trimStart().startsWith("M"), body.id).toBe(true);
      expect(body.d.trimEnd().endsWith("Z"), body.id).toBe(true);
    }
  });

  it("gives every curve six numbers", () => {
    for (const body of BODY_DEFS) {
      for (const segment of body.d.split("C").slice(1)) {
        const numbers = segment.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? [];
        expect(numbers.length % 6, `${body.id} has a ragged curve`).toBe(0);
      }
    }
  });

  it("gives the dog, and only the dog, two ears as decorations", () => {
    for (const body of BODY_DEFS) {
      if (body.id !== "dog") expect(body.decorations, body.id).toBeUndefined();
    }
    const dog = BODY_DEFS.find(s => s.id === "dog");
    const parts = dog.decorations.match(/<path /g) ?? [];
    expect(parts).toHaveLength(2);
    expect(dog.decorations).toContain('class="mascot-part mascot-ear mascot-ear--left"');
    expect(dog.decorations).toContain('class="mascot-part mascot-ear mascot-ear--right"');
    expect(dog.decorations.match(/\{\{GRADIENT\}\}/g)).toHaveLength(2);
  });

  it("traces each ear part along the silhouette's own ear curves", () => {
    const dog = BODY_DEFS.find(s => s.id === "dog");
    // the right ear's outer edge, tip and inner edge, verbatim from the outline
    const rightEar = "C160 50 182 78 184 112C185 130 174 140 160 138C156 134 150 124 146 112";
    // the outline walks the left ear back up, from the notch to the crown;
    // the part walks it down from the crown like the right one. Same curves.
    const leftEarUp = "C50 124 44 134 40 138C26 140 15 130 16 112C18 78 40 50 58 44";
    const leftEarDown = "C40 50 18 78 16 112C15 130 26 140 40 138C44 134 50 124 54 112";
    expect(dog.d).toContain(rightEar);
    expect(dog.d).toContain(leftEarUp);
    expect(dog.decorations).toContain(rightEar);
    expect(dog.decorations).toContain(leftEarDown);
    for (const d of dog.decorations.match(/ d="([^"]+)"/g).map(m => m.slice(4, -1))) {
      const commands = [...new Set(d.match(/[A-Za-z]/g))].sort();
      expect(commands).toEqual(["C", "M", "Z"]);
    }
  });
});
