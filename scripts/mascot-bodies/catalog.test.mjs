import { describe, expect, it } from "vitest";

import {
  DEFAULT_MASCOT_BODY,
  MASCOT_BODIES,
  MASCOT_BODY_IDS,
  botMascotBody,
  mascotBodySchema,
} from "../../shared/mascot-bodies.ts";

describe("the generated catalog", () => {
  it("carries the eight breeds and eight shapes", () => {
    expect(MASCOT_BODY_IDS).toHaveLength(16);
    for (const id of MASCOT_BODY_IDS) expect(MASCOT_BODIES[id].id).toBe(id);
  });

  it("defaults to the dog", () => {
    expect(DEFAULT_MASCOT_BODY).toBe("dog");
  });

  it("gives every body the markup the renderer expects", () => {
    for (const id of MASCOT_BODY_IDS) {
      const entry = MASCOT_BODIES[id];
      expect(entry.body, id).toContain('fill="{{GRADIENT}}"');
      expect(entry.clip, id).not.toContain("fill=");
      expect(entry.fit, id).toMatch(/^translate\(/);
      expect(entry.name.length, id).toBeGreaterThan(0);
    }
  });

  it("carries every outline's own bounds, for the gradient to pin to", () => {
    for (const id of MASCOT_BODY_IDS) {
      const { bounds } = MASCOT_BODIES[id];
      expect(bounds.minX, id).toBeLessThan(bounds.maxX);
      expect(bounds.minY, id).toBeLessThan(bounds.maxY);
    }
    // the 200-unit stage bodies sit on it; the blob's lobe reaches past it
    expect(MASCOT_BODIES.circle.bounds).toEqual({ minX: 0, minY: 0, maxX: 200, maxY: 200 });
    expect(MASCOT_BODIES.blob.bounds.minY).toBeLessThan(0);
  });

  it("decorates the dog with two ears and nothing else", () => {
    for (const id of MASCOT_BODY_IDS) {
      if (id !== "dog") expect(MASCOT_BODIES[id].decorations, id).toBeUndefined();
    }
    const ears = MASCOT_BODIES.dog.decorations;
    expect(ears).toContain('class="mascot-part mascot-ear mascot-ear--left"');
    expect(ears).toContain('class="mascot-part mascot-ear mascot-ear--right"');
    expect(ears.match(/fill="\{\{GRADIENT\}\}"/g)).toHaveLength(2);
  });

  it("places every face inside its body", () => {
    for (const id of MASCOT_BODY_IDS) {
      const { anchor } = MASCOT_BODIES[id];
      expect(anchor.scale, id).toBeGreaterThan(0);
      expect(anchor.scale, id).toBeLessThanOrEqual(1);
      expect(anchor.x, id).toBeGreaterThan(0);
      expect(anchor.y, id).toBeGreaterThan(0);
    }
  });

  it("clamps every face to one shared size", () => {
    const scales = new Set(MASCOT_BODY_IDS.map(id => MASCOT_BODIES[id].anchor.scale));
    expect([...scales]).toHaveLength(1);
  });
});

describe("botMascotBody", () => {
  it("accepts a known id", () => {
    expect(botMascotBody("blob")).toBe("blob");
  });

  it("falls back to the dog for anything else", () => {
    expect(botMascotBody("hexagram")).toBe("dog");
    expect(botMascotBody(undefined)).toBe("dog");
    expect(botMascotBody(null)).toBe("dog");
    expect(botMascotBody(42)).toBe("dog");
  });

  it("exposes a schema that rejects an unknown id", () => {
    expect(mascotBodySchema.safeParse("diamond").success).toBe(true);
    expect(mascotBodySchema.safeParse("nope").success).toBe(false);
  });
});
