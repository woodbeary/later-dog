import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTS = ["tsconfig.json", "tsconfig.server.json"];
const DIAGNOSTIC = /\bTS\d+\b|\berror\b|<error\b/i;

export function typecheck({
  root = ROOT,
  run = spawnSync,
  stdout = (text) => {
    process.stdout.write(text);
  },
  stderr = (text) => {
    process.stderr.write(text);
  },
} = {}) {
  const pin = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies?.bun;
  if (!/^\d+\.\d+\.\d+$/.test(pin ?? "")) {
    stderr("typecheck: package.json must pin an exact Bun version\n");
    return 1;
  }
  const checker = join(root, "node_modules", "bun", "bin", "bun.exe");
  const options = {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  };
  const version = run(checker, ["--version"], options);
  if (version.error || version.signal || version.status !== 0 || version.stdout?.trim() !== pin) {
    const reason =
      version.error?.message ||
      version.signal ||
      version.stderr?.trim() ||
      version.stdout?.trim() ||
      `exit ${version.status}`;
    stderr(
      `typecheck: pinned Bun ${pin} is unavailable at ${checker}: ${reason}; run pnpm install --frozen-lockfile\n`,
    );
    return 1;
  }
  let failed = false;
  for (const project of PROJECTS) {
    stdout(`\n== typecheck ${project}\n`);
    const result = run(checker, ["check", "--no-script", "--no-pretty", "-p", project], options);
    if (result.stdout) stdout(result.stdout);
    if (result.stderr) stderr(result.stderr);
    const output = stripVTControlCharacters(`${result.stdout ?? ""}${result.stderr ?? ""}`);
    const checked = [
      ...output.matchAll(/\bNo type errors in ([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*) files?\b/g),
    ];
    if (
      result.error ||
      result.signal ||
      result.status !== 0 ||
      DIAGNOSTIC.test(output) ||
      checked.length !== 1
    ) {
      stderr(
        `typecheck ${project} failed: ${result.error?.message ?? result.signal ?? (result.status !== 0 ? `exit ${result.status}` : "no clean, nonempty checker result")}\n`,
      );
      failed = true;
    } else {
      stdout(`typecheck ${project}: checked ${checked[0][1].replaceAll(",", "")} files\n`);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = typecheck();
