import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface GitSources {
  binary: string;
  home: string;
  systemConfig?: string;
}

export const DEFAULT_GIT: GitSources = { binary: "git", home: homedir() };

const SEARCH_PATH = "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin";
const TIMEOUT_MS = 3_000;

function gitEnvironment(sources: GitSources): NodeJS.ProcessEnv {
  return {
    PATH: SEARCH_PATH,
    HOME: sources.home,
    LANG: "C",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    ...(sources.systemConfig !== undefined ? { GIT_CONFIG_SYSTEM: sources.systemConfig } : {}),
  };
}

type Answer = { ok: true; out: string; status: number } | { ok: false };

function ask(cwd: string, args: readonly string[], sources: GitSources): Answer {
  try {
    const result = spawnSync(sources.binary, args, {
      cwd, env: gitEnvironment(sources), timeout: TIMEOUT_MS, encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 20,
    });
    if (result.error || result.signal || typeof result.status !== "number") return { ok: false };
    return { ok: true, out: result.stdout.trim(), status: result.status };
  } catch {
    return { ok: false };
  }
}

const HOOK_MANAGERS = [".husky", ".githooks", "lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml", "lefthook-local.yml",
  ".pre-commit-config.yaml", ".pre-commit-config.yml", ".simple-git-hooks.json", ".simple-git-hooks.js", ".simple-git-hooks.cjs"];

export interface HookFacts {
  state: "none" | "hooks" | "doubt";
  hooksPath?: string;
}

export function hookFacts(cwd: string, sources: GitSources = DEFAULT_GIT): HookFacts {
  const top = ask(cwd, ["rev-parse", "--show-toplevel"], sources);
  if (!top.ok || top.status !== 0 || !isAbsolute(top.out)) return { state: "doubt" };
  const configured = ask(cwd, ["config", "--get", "core.hooksPath"], sources);
  if (!configured.ok || (configured.status !== 0 && configured.status !== 1)) return { state: "doubt" };
  const setting = configured.status === 0 ? configured.out : "";
  const hooksPath = setting ? (isAbsolute(setting) ? setting : join(top.out, setting)) : undefined;
  if (hooksPath) return { state: "hooks", hooksPath };
  const path = ask(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], sources);
  if (!path.ok || path.status !== 0 || !isAbsolute(path.out)) return { state: "doubt" };
  try {
    if (existsSync(path.out) && readdirSync(path.out).some((name) => !name.endsWith(".sample"))) return { state: "hooks", hooksPath: path.out };
  } catch {
    return { state: "doubt" };
  }
  if (HOOK_MANAGERS.some((name) => existsSync(join(top.out, name)))) return { state: "hooks" };
  try {
    const manifest = join(top.out, "package.json");
    if (existsSync(manifest) && /"(?:husky|simple-git-hooks|pre-commit|lint-staged|lefthook)"/.test(readFileSync(manifest, "utf8"))) return { state: "hooks" };
  } catch {
    return { state: "doubt" };
  }
  return { state: "none" };
}

export function gitRemotes(cwd: string, sources: GitSources = DEFAULT_GIT): Set<string> {
  const answer = ask(cwd, ["remote"], sources);
  return answer.ok && answer.status === 0 ? new Set(answer.out.split("\n").map((line) => line.trim()).filter(Boolean)) : new Set();
}
