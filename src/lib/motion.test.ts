import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MOTION } from "./motion";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/** The token's value in the stylesheet, in ms, or null when it is not declared. */
function declared(name: keyof typeof MOTION): number | null {
  const match = css.match(new RegExp(`--motion-${name}:\\s*(\\d+)ms;`));
  return match ? Number(match[1]) : null;
}

describe("motion tokens", () => {
  it("are the numbers the stylesheet declares", () => {
    for (const name of Object.keys(MOTION) as (keyof typeof MOTION)[]) {
      expect(declared(name), `--motion-${name}`).toBe(MOTION[name]);
    }
  });

  it("step up from a control's answer to an arrival, within the UI ceiling", () => {
    expect(MOTION.micro).toBeLessThan(MOTION.base);
    expect(MOTION.base).toBeLessThan(MOTION.enter);
    expect(MOTION.enter).toBeLessThanOrEqual(400);
  });

  it("declare both easings once", () => {
    expect(css.match(/--ease-out-soft:/g)).toHaveLength(1);
    expect(css.match(/--ease-in-out-soft:/g)).toHaveLength(1);
  });

  it("leave no fixed second-scale duration on the app's entrances", () => {
    // Entrances read their length from the tokens; a literal here is a
    // regression to the ad-hoc numbers the tokens replaced.
    for (const name of ["msg-in", "pop-in", "pop-out", "panel-in", "rise", "spot-in"]) {
      const line = css.match(new RegExp(`--animate-${name}:[^;]+;`))?.[0] ?? "";
      expect(line, name).toContain("var(--motion-");
      expect(line, name).not.toMatch(/\d+s\b|\d+ms\b/);
    }
  });
});
