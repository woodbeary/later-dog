import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DURATION, EASE, MOTION, PRESS_SCALE, SPRINGS, springDuration, springEasing } from "./motion";

const tokens = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

function declaredIn(source: string, name: string): string | null {
  return source.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim() ?? null;
}

describe("motion tokens", () => {
  it("declare every duration once, as the numbers the code uses", () => {
    for (const name of Object.keys(DURATION) as (keyof typeof DURATION)[]) {
      expect(tokens.match(new RegExp(`--duration-${name}:`, "g")), name).toHaveLength(1);
      expect(declaredIn(tokens, `--duration-${name}`), name).toBe(`${DURATION[name]}ms`);
    }
    expect(declaredIn(tokens, "--duration-exit")).toBe(`${MOTION.exit}ms`);
  });

  it("keep the older names as aliases of the scale", () => {
    expect(declaredIn(tokens, "--motion-micro")).toBe("var(--duration-fast)");
    expect(declaredIn(tokens, "--motion-base")).toBe("var(--duration-slow)");
    expect(declaredIn(tokens, "--motion-enter")).toBe("var(--duration-slower)");
    expect(MOTION.micro).toBe(DURATION.fast);
    expect(MOTION.base).toBe(DURATION.slow);
    expect(MOTION.enter).toBe(DURATION.slower);
  });

  it("step up from a control's answer to an arrival, within the UI ceiling", () => {
    const steps = [DURATION.instant, DURATION.fast, DURATION.normal, DURATION.slow, DURATION.slower];
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(DURATION.slower).toBeLessThanOrEqual(400);
  });

  it("declare the easings once, as the numbers the code uses", () => {
    for (const name of ["enter", "exit", "loop"] as const) {
      expect(tokens.match(new RegExp(`--ease-${name}:`, "g")), name).toHaveLength(1);
      expect(declaredIn(tokens, `--ease-${name}`), name).toBe(EASE[name]);
    }
    expect(css).not.toMatch(/--ease-out-soft:/);
  });

  it("compile each spring to the curve the stylesheet carries", () => {
    for (const name of Object.keys(SPRINGS) as (keyof typeof SPRINGS)[]) {
      expect(declaredIn(tokens, `--spring-${name}`), name).toBe(springEasing(SPRINGS[name]));
      expect(declaredIn(tokens, `--spring-${name}-duration`), name).toBe(`${springDuration(SPRINGS[name])}ms`);
    }
  });

  it("settle each spring at its target, the bouncy one after passing it", () => {
    const stops = (name: keyof typeof SPRINGS) =>
      springEasing(SPRINGS[name]).slice(7, -1).split(", ").map(Number);
    for (const name of Object.keys(SPRINGS) as (keyof typeof SPRINGS)[]) {
      expect(stops(name)[0]).toBe(0);
      expect(stops(name).at(-1)).toBe(1);
    }
    expect(Math.max(...stops("bounce"))).toBeGreaterThan(1.02);
    expect(Math.max(...stops("standard"))).toBeLessThanOrEqual(1);
    expect(Math.max(...stops("slow"))).toBeLessThanOrEqual(1);
  });

  it("squish buttons to the same scale in code and stylesheet", () => {
    expect(declaredIn(tokens, "--press-scale")).toBe(String(PRESS_SCALE));
  });

  it("name the radii and elevations the surfaces use", () => {
    const radii = { bubble: "18px", card: "16px", question: "24px", menu: "12px", sheet: "24px", control: "8px" };
    for (const [name, value] of Object.entries(radii)) {
      expect(declaredIn(tokens, `--radius-${name}`), name).toBe(value);
    }
    for (const name of ["control", "inline", "popover", "modal", "window", "elevated", "composer"]) {
      expect(tokens, name).toContain(`--shadow-${name}:`);
    }
    for (const name of ["subtle", "weak", "default", "strong"]) {
      expect(tokens, name).toContain(`--hairline-${name}:`);
    }
  });

  it("leave no fixed second-scale duration on the app's entrances", () => {
    for (const name of ["msg-in", "pop-in", "pop-out", "sheet-in", "scrim-in", "panel-in", "rise", "spot-in"]) {
      const line = css.match(new RegExp(`--animate-${name}:[^;]+;`))?.[0] ?? "";
      expect(line, name).toMatch(/var\(--(duration|motion|spring)-/);
      expect(line, name).not.toMatch(/\d+s\b|\d+ms\b/);
    }
  });

  it("import the tokens before anything uses them", () => {
    expect(css.indexOf('@import "./tokens.css"')).toBeGreaterThan(-1);
    expect(css).not.toMatch(/--motion-(micro|base|enter):\s*\d/);
  });
});
