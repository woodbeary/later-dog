import { describe, expect, it } from "vitest";
import { NOVNC_BASE, NOVNC_ENTRY, NOVNC_MODULES, NOVNC_VERSION } from "../src/novnc";

const fsModule = "node:fs";
const pathModule = "node:path";
const urlModule = "node:url";
const { existsSync, readFileSync } = await import(fsModule);
const { dirname, join, normalize } = await import(pathModule);
const { fileURLToPath } = await import(urlModule);

const HERE: string = dirname(fileURLToPath((import.meta as unknown as { url: string }).url));
const ASSETS: string = join(HERE, "..", "..", "..", "..", "third_party", "novnc", "public");
const ROOT: string = join(ASSETS, NOVNC_BASE);

function importsOf(file: string): string[] {
  const source: string = readFileSync(join(ROOT, file), "utf8");
  const found: RegExpMatchArray[] = [...source.matchAll(/(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|import\(['"]([^'"]+)['"]\)/g)];
  return found.map((match) => match[1] ?? match[2] ?? match[3]!).filter((target) => target.startsWith(".")).map((target): string => normalize(join(dirname(file), target)));
}

function graph(entry: string): string[] {
  const seen: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.includes(file)) continue;
    seen.push(file);
    queue.push(...importsOf(file));
  }
  return seen;
}

describe("noVNC served as static assets", () => {
  it("has the entry module at a versioned path with no token in it", () => {
    expect(NOVNC_ENTRY).toBe(`/novnc/${NOVNC_VERSION}/core/rfb.js`);
    expect(existsSync(join(ASSETS, NOVNC_ENTRY))).toBe(true);
  });

  it("lists exactly the modules the entry imports, so the page preloads all of them and nothing is missing", () => {
    expect([...NOVNC_MODULES].sort()).toEqual(graph("core/rfb.js").sort());
    for (const file of NOVNC_MODULES) expect(existsSync(join(ROOT, file)), file).toBe(true);
  });

  it("is cached for a year and marked immutable", () => {
    const headers = readFileSync(join(ASSETS, "_headers"), "utf8");
    expect(headers).toContain("/novnc/*");
    expect(headers).toContain("Cache-Control: public, max-age=31536000, immutable");
  });

  it("keeps the licence notices that came with the library", () => {
    expect(readFileSync(join(ROOT, "core", "rfb.js"), "utf8")).toContain("Licensed under MPL 2.0");
    expect(readFileSync(join(ROOT, "COPYRIGHT.txt"), "utf8")).toContain("License: MPL-2.0");
    expect(readFileSync(join(ROOT, "LICENSE-MPL-2.0.txt"), "utf8")).toContain("Mozilla Public License Version 2.0");
  });

  it("is what the Worker's wrangler config serves", () => {
    const config = readFileSync(join(HERE, "..", "wrangler.jsonc"), "utf8");
    expect(config).toContain('"assets": { "directory": "../../../third_party/novnc/public" }');
  });
});
