import { describe, expect, it } from "vitest";

import { dogGuidance, MEDICINE_FOR_A_CHILD, PAYMENTS_BLOCK, SAFETY_FLOOR } from "./dog-guidance.ts";

describe("the safety line every dog keeps", () => {
  it("names the four rules in plain words", () => {
    expect(SAFETY_FLOOR).toMatch(/never release money/i);
    expect(SAFETY_FLOOR).toMatch(/never copy full card or identity numbers/i);
    expect(SAFETY_FLOOR).toMatch(/never send anything in a person's name that they have not read/i);
    expect(SAFETY_FLOOR).toMatch(/take a child's dose only from the product's own label/i);
  });

  it("reaches a dog of any title, while the long blocks stay with the titles that need them", () => {
    for (const title of ["Travel dog", "Research dog", "Build dog", ""]) {
      for (const engine of ["claude", "codex", "other"] as const) {
        const text = dogGuidance({ engine, agents: true, model: "claude-opus-5-5", role: { title } });
        expect([title, engine, text.includes(SAFETY_FLOOR)]).toEqual([title, engine, true]);
      }
    }
    const travel = dogGuidance({ engine: "claude", agents: true, model: "claude-opus-5-5", role: { title: "Travel dog" } });
    expect(travel).not.toContain(PAYMENTS_BLOCK);
    expect(travel).not.toContain(MEDICINE_FOR_A_CHILD);
    expect(dogGuidance({ engine: "claude", agents: true, model: "claude-opus-5-5" })).toContain(SAFETY_FLOOR);
  });
});
