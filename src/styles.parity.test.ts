import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SKIN_IDS } from "@/lib/skins";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function skin(id: string): Map<string, string> {
  const body = css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim().toLowerCase()]));
}

const ROLES: Array<[string, string, string]> = [
  ["--color-app", "#fcfcfc", "#070707"],
  ["--color-panel", "#f7f7f7", "#111111"],
  ["--color-lift", "#ffffff", "#1c1c1e"],
  ["--color-bubble", "#1010000b", "#f7eaea0e"],
  ["--color-card", "#eeeeee", "#262626"],
  ["--color-disc", "#eeeeee", "#5c5c5c"],
  ["--color-wash", "#7676801f", "#7676803d"],
  ["--color-ink", "#0d0d0d", "#fcfcfc"],
  ["--color-ink-secondary", "#6b6b70", "#9c9ca2"],
  ["--color-faint", "#b0b0b4", "#828288"],
  ["--color-hairline", "#e5e5ea", "#2c2c2e"],
  ["--color-bubble-user", "#0b0b0b", "#5c5c5c"],
  ["--color-bubble-user-ink", "#ffffff", "#ffffff"],
  ["--color-accent", "#0b0b0b", "#f5f5f5"],
  ["--color-accent-ink", "#ffffff", "#0b0b0b"],
  ["--color-working", "#3fa266", "#3fa266"],
  ["--color-waiting", "#b77400", "#b77400"],
  ["--color-waiting-text", "#885a07", "#db941e"],
  ["--color-unread", "#2d6ae3", "#2d6ae3"],
  ["--color-link", "#0a60d0", "#6ab0ff"],
  ["--color-danger", "#c02b3a", "#ff5667"],
];

const NEW_TOKENS = ["--color-lift", "--color-bubble", "--color-disc", "--color-wash", "--color-faint", "--color-working", "--color-link"];

describe("the quiet colours on the desktop", () => {
  it.each(ROLES)("gives %s its Daylight and Midnight value", (token, daylight, midnight) => {
    expect(skin("daylight").get(token)).toBe(daylight);
    expect(skin("midnight").get(token)).toBe(midnight);
  });

  it("names every new role in every skin and in the default theme, so each skin draws them from its own colours", () => {
    const theme = css.match(/@theme \{([^}]*)\}/)?.[1] ?? "";
    for (const token of NEW_TOKENS) expect(theme).toContain(`${token}:`);
    for (const id of SKIN_IDS) {
      const declared = skin(id);
      expect(NEW_TOKENS.filter((token) => !declared.has(token)), id).toEqual([]);
    }
  });

  it("keeps the other skins' own hues for the new roles instead of Daylight's or Midnight's", () => {
    for (const id of SKIN_IDS.filter((candidate) => candidate !== "daylight" && candidate !== "midnight")) {
      const declared = skin(id);
      for (const token of ["--color-lift", "--color-bubble", "--color-disc", "--color-wash", "--color-faint"]) {
        expect(declared.get(token), `${id} ${token}`).toMatch(/var\(--color-(ink|app|composer)\)/);
      }
    }
  });
});
