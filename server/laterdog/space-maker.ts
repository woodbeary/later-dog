import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildOutputProject, findBuildOutput, sizeOf } from "./janitor.ts";
import { isEngineProcess, readProcesses, type ProcessInfo } from "./process-reaper.ts";

export const REBUILT_CACHES = [".npm/_cacache", ".cache/pip", ".cache/uv", ".cache/node-gyp", ".cache/yarn", ".cache/go-build", ".cache/next-swc", ".bun/install/cache"];
const INSTALLER = /(?:^|[\s/])(?:pnpm|npm|npx|yarn|bun|pip3?|uv)(?:\s|$)/;

export interface SpaceMakerDeps {
  home: string;
  workspacesDir: string;
  busyDirs: readonly string[];
  processes?: () => ProcessInfo[];
  pruneStore?: () => void;
}

const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

export function inUse(buildDir: string, busyDirs: readonly string[], live: readonly ProcessInfo[]): boolean {
  const project = buildOutputProject(buildDir);
  if (busyDirs.some((dir) => within(buildDir, dir))) return true;
  return live.some((proc) => within(proc.cwd, project) || proc.argv.includes(project));
}

export function rebuildableOutput(home: string, workspacesDir: string): string[] {
  let names: string[] = [];
  try { names = readdirSync(home); } catch {}
  const roots = names.filter((name) => !name.startsWith(".")).map((name) => join(home, name));
  return [...roots, workspacesDir].flatMap((root) => findBuildOutput(root, 7));
}

function pnpmStorePrune(home: string): void {
  spawnSync("pnpm", ["store", "prune"], { cwd: home, timeout: 120_000, stdio: "ignore", env: { ...process.env, HOME: home } });
}

export function makeSpace(deps: SpaceMakerDeps): { freed: number; cleared: string[] } {
  const live = (deps.processes ?? readProcesses)().filter((proc) => !isEngineProcess(proc.argv));
  const cleared: string[] = [];
  let freed = 0;
  const clear = (path: string) => {
    const bytes = sizeOf(path);
    if (!bytes) return;
    try {
      rmSync(path, { recursive: true, force: true });
      freed += bytes;
      cleared.push(path);
    } catch {}
  };
  for (const path of rebuildableOutput(deps.home, deps.workspacesDir)) if (!inUse(path, deps.busyDirs, live)) clear(path);
  const installing = live.some((proc) => INSTALLER.test(proc.argv));
  if (!installing) {
    for (const cache of REBUILT_CACHES) clear(join(deps.home, cache));
    const storeDir = join(deps.home, ".local/share/pnpm");
    const before = sizeOf(storeDir);
    try { (deps.pruneStore ?? (() => pnpmStorePrune(deps.home)))(); } catch {}
    freed += Math.max(0, before - sizeOf(storeDir));
  }
  return { freed, cleared };
}
