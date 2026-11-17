import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SKIN_IDS } from "./skins";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(src, "styles.css"), "utf8");

function declared(body: string): Set<string> {
  return new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name));
}

const theme = declared(css.match(/@theme\s*\{([^}]*)\}/)?.[1] ?? "");
const inEverySkin = (name: string) => SKIN_IDS.every(id => theme.has(name) || declared(css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "").has(name));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("colour token fallbacks", () => {
  it("leaves no fallback on a colour token every skin declares", () => {
    const found = sources(src).flatMap(path => [...readFileSync(path, "utf8").matchAll(/var\((--color-[\w-]+)\s*,/g)]
      .filter(([, name]) => inEverySkin(name))
      .map(([, name]) => `${relative(src, path)} ${name}`));
    expect(found).toEqual([]);
  });
});
