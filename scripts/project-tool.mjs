import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function projectToolCommand(
  repo,
  tool,
  args,
  { node = process.execPath, run = spawnSync, exists = existsSync } = {},
) {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  const manager = pkg.packageManager;
  const bun = /^bun@(\d+\.\d+\.\d+)$/.exec(manager ?? "");
  if (bun) {
    if (pkg.devDependencies?.bun !== bun[1])
      throw new Error("Bun " + bun[1] + " must also be pinned in devDependencies.");
    const binary = join(repo, "node_modules", "bun", "bin", "bun.exe");
    const version = run(binary, ["--version"], { cwd: repo, encoding: "utf8" });
    if (
      version.error ||
      version.signal ||
      version.status !== 0 ||
      version.stdout?.trim() !== bun[1]
    ) {
      throw new Error(
        "Bun " +
          bun[1] +
          " is unavailable in " +
          repo +
          ". Install that checkout's dependencies first.",
      );
    }
    return { file: binary, args: ["run", tool, ...args], manager: "bun" };
  }
  if (/^pnpm@\d+\.\d+\.\d+(?:\+sha(?:224|256|384|512)\.[a-f0-9]+)?$/.test(manager ?? "")) {
    const sibling = join(dirname(node), "corepack");
    return {
      file: exists(sibling) ? sibling : "corepack",
      args: [manager, "exec", tool, ...args],
      manager: "pnpm",
    };
  }
  throw new Error("Unsupported package manager in " + repo + "/package.json.");
}
