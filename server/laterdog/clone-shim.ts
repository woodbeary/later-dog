import { accessSync, constants, mkdirSync, realpathSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { writeFileAtomicIfChanged } from "../atomic.ts";

const quoted = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

export function realGit(path: string | undefined, shimDir: string): string | null {
  const own = resolve(shimDir);
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir || resolve(dir) === own) continue;
    const candidate = join(dir, "git");
    try {
      accessSync(candidate, constants.X_OK);
      const real = realpathSync(candidate);
      if (!real.startsWith(`${own}/`)) return candidate;
    } catch {}
  }
  return null;
}

export function shimScript(git: string, node: string, helper: string): string {
  return [
    "#!/bin/sh",
    `if [ "$1" = clone ]; then export LATERDOG_REAL_GIT=${quoted(git)}; exec ${quoted(node)} ${quoted(helper)} "$@"; fi`,
    `exec ${quoted(git)} "$@"`,
    "",
  ].join("\n");
}

export function cloneShimEnvironment(path: string | undefined, shimDir: string, node: string, helper: string): Record<string, string> {
  const git = realGit(path, shimDir);
  if (!git) return {};
  try {
    mkdirSync(shimDir, { recursive: true, mode: 0o755 });
    writeFileAtomicIfChanged(join(shimDir, "git"), shimScript(git, node, helper), { mode: 0o755, durable: false });
  } catch {
    return {};
  }
  return { PATH: [shimDir, ...(path ?? "").split(delimiter).filter((dir) => dir && resolve(dir) !== resolve(shimDir))].join(delimiter) };
}
