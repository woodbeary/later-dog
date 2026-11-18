import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "..");
const BUILT = ["esbuild", "workerd"];
const STANDALONE = ["deploy/laterdog/home", "deploy/laterdog/cloudflare", "deploy/laterdog/computers"];

describe("packages installed on their own let their build scripts run", () => {
  it.each(STANDALONE)("allows esbuild and workerd in %s, which installs on its own and never reads the workspace file", (folder) => {
    const manifest = JSON.parse(readFileSync(join(ROOT, folder, "package.json"), "utf8")) as { pnpm?: { onlyBuiltDependencies?: string[] } };
    expect(manifest.pnpm?.onlyBuiltDependencies).toEqual(BUILT);
  });

  it("allows esbuild and workerd in the workspace, whose workers run on workerd", () => {
    const workspace = parse(readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8")) as { allowBuilds?: Record<string, boolean>; onlyBuiltDependencies?: string[] };
    for (const name of BUILT) {
      expect(workspace.allowBuilds?.[name]).toBe(true);
      expect(workspace.onlyBuiltDependencies).toContain(name);
    }
  });
});
