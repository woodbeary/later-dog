import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, normalize } from "node:path";

const MEMORY_FILES = ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", ".claude/rules/**"] as const;

function escapeGlob(path: string): string {
  return path.replace(/[\\*?[\]{}()!+@]/g, (char) => `\\${char}`);
}

function withAncestors(start: string): string[] {
  const dirs: string[] = [];
  for (let dir = normalize(start); ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dirname(dir) === dir) return dirs;
  }
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function machineClaudeMemoryExcludes(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const dirs = new Set([home, realPath(home)].flatMap(withAncestors));
  return [...dirs].flatMap((dir) => {
    const base = escapeGlob(dir.replaceAll("\\", "/")).replace(/\/+$/, "");
    return MEMORY_FILES.map((file) => `${base}/${file}`);
  });
}
