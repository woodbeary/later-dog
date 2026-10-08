import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { BRAND_INK, BRAND_MARKS, BRAND_TILE, MIN_MARK_CONTRAST, brandMark, contrastRatio, markColor } from "./brand-icons";
import { MCP_CONNECTORS } from "./mcp-connectors";

// SVG path data and nothing else: commands and numbers, no markup or URLs.
const PATH_DATA = /^[Mm][MmZzLlHhVvCcSsQqTtAa0-9.,\s-]+$/;

describe("brand marks for the connector catalog", () => {
  it("has a mark for every connector, so one added without a mark fails here", () => {
    for (const connector of MCP_CONNECTORS) {
      const mark = brandMark(connector.id);
      expect(mark, `${connector.id} needs an entry in BRAND_MARKS (src/lib/brand-icons.ts)`).toBeDefined();
      expect(mark?.title, connector.id).toBe(connector.name);
    }
  });

  it("ships the catalog's marks and no others", () => {
    expect(Object.keys(BRAND_MARKS).sort()).toEqual(MCP_CONNECTORS.map((connector) => connector.id).sort());
  });

  it("keeps each entry to a brand colour, plain path data and https links", () => {
    for (const [id, mark] of Object.entries(BRAND_MARKS)) {
      expect(mark.hex, id).toMatch(/^[0-9A-F]{6}$/);
      expect(mark.path, id).toMatch(PATH_DATA);
      for (const link of [mark.source, ...(mark.guidelines ? [mark.guidelines] : [])]) {
        expect(new URL(link).protocol, `${id}: ${link}`).toBe("https:");
      }
    }
  });

  it("finds nothing for another service or an inherited property name", () => {
    expect(brandMark("gmail")).toBeUndefined();
    expect(brandMark("constructor")).toBeUndefined();
    expect(brandMark("toString")).toBeUndefined();
  });

  it("measures contrast as WCAG does", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#FFFFFF")).toBe(1);
    expect(contrastRatio("#6AFDEF", BRAND_TILE)).toBeCloseTo(1.24, 2);
  });

  it("draws each mark in its brand colour unless that colour would vanish on the white tile", () => {
    for (const [id, mark] of Object.entries(BRAND_MARKS)) {
      const brand = `#${mark.hex}`;
      const drawn = markColor(mark);
      expect(drawn, id).toBe(contrastRatio(brand, BRAND_TILE) >= MIN_MARK_CONTRAST ? brand : BRAND_INK);
      expect(contrastRatio(drawn, BRAND_TILE), id).toBeGreaterThanOrEqual(MIN_MARK_CONTRAST);
    }
    // Intercom's pale cyan falls back to its black form; Neon's lighter green still reads
    expect(markColor(BRAND_MARKS.intercom)).toBe(BRAND_INK);
    expect(markColor(BRAND_MARKS.neon)).toBe("#34D59A");
    expect(markColor(BRAND_MARKS.cloudflare)).toBe("#F38020");
  });

  it("copies the marks rather than depending on the simple-icons package", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      expect(Object.keys(manifest[field] ?? {}), field).not.toContain("simple-icons");
    }
  });
});
