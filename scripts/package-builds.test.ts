import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const BUILT = ["esbuild", "workerd"];
const STANDALONE = [
  "deploy/laterdog/home",
  "deploy/laterdog/cloudflare",
  "deploy/laterdog/computers",
];

describe("packages installed on their own let their build scripts run", () => {
  it.each(STANDALONE)(
    "allows esbuild and workerd in %s without a parent workspace policy",
    (folder) => {
      const manifest = JSON.parse(readFileSync(join(ROOT, folder, "package.json"), "utf8")) as {
        trustedDependencies?: string[];
      };
      expect(manifest.trustedDependencies).toEqual(BUILT);
    },
  );

  it("permits the workspace native tools and keeps other lifecycle hooks untrusted", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      trustedDependencies?: string[];
    };
    for (const name of ["bun", "electron", ...BUILT])
      expect(manifest.trustedDependencies).toContain(name);
    expect(manifest.trustedDependencies).not.toContain("electron-winstaller");
  });
});
