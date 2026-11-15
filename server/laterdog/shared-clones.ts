import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { sizeOf } from "./janitor.ts";

export const REPO_CACHE_ROOT = () => join(homedir(), ".cache", "laterdog-repos");
export const LOCK_WAIT_MS = 3 * 60_000;
export const OWNERLESS_STALE_MS = 5_000;
export const UNSHARED_CACHE_DAYS = 7;
const USED_STAMP = "laterdog-used";

const NO_VALUE = new Set(["-q", "--quiet", "-v", "--verbose", "--progress", "-n", "--no-checkout", "--single-branch", "--no-single-branch", "--no-tags"]);
const WITH_VALUE = new Set(["-b", "--branch", "-o", "--origin", "-c", "--config"]);
const NETWORK = /^(?:https?|ssh|git|git\+ssh|ssh\+git|file):\/\//i;
const SCP = /^[^\s/:@]+@[^\s/:]+:(?!\/\/)/;

export interface ClonePlan {
  url: string;
  dir: string | null;
  options: string[];
  origin: string;
}

export function isNetworkRemote(url: string): boolean {
  return NETWORK.test(url) || SCP.test(url);
}

export function parseClone(args: readonly string[]): ClonePlan | null {
  if (args[0] !== "clone") return null;
  const options: string[] = [];
  const positional: string[] = [];
  let origin = "origin";
  let rest = false;
  for (let at = 1; at < args.length; at += 1) {
    const arg = args[at]!;
    if (rest || !arg.startsWith("-") || arg === "-") { positional.push(arg); continue; }
    if (arg === "--") { rest = true; continue; }
    if (NO_VALUE.has(arg)) { options.push(arg); continue; }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!WITH_VALUE.has(name) || (eq !== -1 && !name.startsWith("--"))) return null;
    const value = eq === -1 ? args[at + 1] : arg.slice(eq + 1);
    if (value === undefined) return null;
    if (eq === -1) at += 1;
    if (name === "-o" || name === "--origin") origin = value;
    options.push(name, value);
  }
  if (positional.length < 1 || positional.length > 2) return null;
  const [url, dir] = positional as [string, string | undefined];
  if (!isNetworkRemote(url)) return null;
  return { url, dir: dir ?? null, options, origin };
}

export function cloneDirName(url: string): string {
  let path = url.replace(/[/\\]+$/, "").replace(/\/\.git$/, "").replace(/[/\\]+$/, "");
  const scheme = path.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*$/i);
  if (scheme) path = path.replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?/i, "").replace(/:\d+$/, "");
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf(":")) + 1);
  return name.replace(/\.(?:git|bundle)$/, "") || name;
}

export function cacheKey(url: string): string {
  let plain = url.trim();
  if (NETWORK.test(plain)) {
    try {
      const parsed = new URL(plain);
      plain = `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
    } catch {}
  } else plain = plain.replace(/^[^@]*@/, "");
  plain = plain.replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  const tail = (plain.split(/[/:]/).pop() ?? "repo").replace(/[^\w.-]/g, "_").slice(0, 40) || "repo";
  return `${tail}-${createHash("sha256").update(plain).digest("hex").slice(0, 16)}`;
}

export interface CloneRunner {
  git: string;
  cacheRoot: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  lockWaitMs?: number;
  now?: () => number;
}

function run(runner: CloneRunner, args: readonly string[], options: SpawnSyncOptions = {}) {
  return spawnSync(runner.git, args, { cwd: runner.cwd, env: runner.env ?? process.env, stdio: ["ignore", "ignore", "inherit"], ...options });
}

function ok(result: ReturnType<typeof spawnSync>): boolean {
  return !result.error && result.status === 0;
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export const PROGRESS_EVERY_MS = 5_000;

export function takeLock(path: string, waitMs: number, now: () => number = Date.now, progress?: () => number): (() => void) | null {
  let until = now() + waitMs;
  let seen = progress?.();
  let checked = now();
  for (;;) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, "owner"), String(process.pid));
      return () => rmSync(path, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
    }
    let owner = Number.NaN;
    let since = now();
    try { owner = Number(readFileSync(join(path, "owner"), "utf8")); } catch {}
    try { since = statSync(path).mtimeMs; } catch {}
    const ownerless = !(Number.isInteger(owner) && owner > 0);
    if (ownerless ? now() - since > OWNERLESS_STALE_MS : !alive(owner)) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    if (progress && now() - checked >= PROGRESS_EVERY_MS) {
      const next = progress();
      if (next !== seen) until = now() + waitMs;
      seen = next;
      checked = now();
    }
    if (now() >= until) return null;
    pause(250);
  }
}

function defaultBranch(runner: CloneRunner, url: string): string | null {
  const listed = run(runner, ["ls-remote", "--symref", url, "HEAD"], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  if (!ok(listed)) return null;
  const found = String(listed.stdout).match(/^ref:\s+(refs\/heads\/\S+)\s+HEAD$/m);
  return found ? found[1]! : null;
}

function refresh(runner: CloneRunner, cache: string, url: string): boolean {
  const fetched = run(runner, ["-C", cache, "fetch", "--quiet", "--no-write-fetch-head", "--prune", "--prune-tags", "--", url, "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"]);
  if (!ok(fetched)) return false;
  const head = defaultBranch(runner, url);
  if (head && ok(run(runner, ["-C", cache, "rev-parse", "--verify", "--quiet", head]))) run(runner, ["-C", cache, "symbolic-ref", "HEAD", head]);
  return true;
}

function build(runner: CloneRunner, cacheRoot: string, key: string, url: string): string | null {
  for (const name of readdirSync(cacheRoot)) if (name.startsWith(`${key}.tmp-`)) rmSync(join(cacheRoot, name), { recursive: true, force: true });
  const temp = join(cacheRoot, `${key}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  const made = ok(run(runner, ["init", "--quiet", "--bare", temp]))
    && ok(run(runner, ["-C", temp, "config", "gc.auto", "0"]))
    && ok(run(runner, ["-C", temp, "config", "core.logAllRefUpdates", "false"]))
    && ok(run(runner, ["-C", temp, "config", "fetch.unpackLimit", "1"]))
    && refresh(runner, temp, url);
  if (!made) { rmSync(temp, { recursive: true, force: true }); return null; }
  const cache = join(cacheRoot, `${key}.git`);
  try {
    renameSync(temp, cache);
  } catch {
    rmSync(temp, { recursive: true, force: true });
    return null;
  }
  return cache;
}

function keepSharedPacks(target: string): void {
  const packs = join(target, ".git", "objects", "pack");
  let names: string[] = [];
  try { names = readdirSync(packs); } catch { return; }
  for (const name of names) {
    if (!name.endsWith(".pack")) continue;
    try { if (lstatSync(join(packs, name)).nlink > 1) writeFileSync(join(packs, name.replace(/\.pack$/, ".keep")), ""); } catch {}
  }
}

export function cacheBytes(cacheRoot: string, key: string): number {
  let names: string[] = [];
  try { names = readdirSync(cacheRoot); } catch { return 0; }
  return names.filter((name) => name.startsWith(`${key}.tmp-`) || name === `${key}.git`).reduce((sum, name) => sum + sizeOf(join(cacheRoot, name)), 0);
}

function emptyOrMissing(path: string): boolean {
  try { return readdirSync(path).length === 0; } catch { return !existsSync(path); }
}

export type CloneOutcome = "shared" | "plain";

export function sharedClone(args: readonly string[], runner: CloneRunner): { outcome: CloneOutcome; status: number } {
  const plain = () => {
    const result = spawnSync(runner.git, args, { cwd: runner.cwd, env: runner.env ?? process.env, stdio: "inherit" });
    return { outcome: "plain" as const, status: result.status ?? 1 };
  };
  const plan = parseClone(args);
  if (!plan) return plain();
  const target = resolve(runner.cwd, plan.dir ?? cloneDirName(plan.url));
  if (!emptyOrMissing(target)) return plain();
  try { mkdirSync(runner.cacheRoot, { recursive: true, mode: 0o700 }); } catch { return plain(); }
  const key = cacheKey(plan.url);
  const release = takeLock(join(runner.cacheRoot, `${key}.lock`), runner.lockWaitMs ?? LOCK_WAIT_MS, runner.now, () => cacheBytes(runner.cacheRoot, key));
  if (!release) return plain();
  let shared = false;
  let cloned = false;
  let existed = false;
  try {
    const free = emptyOrMissing(target);
    existed = existsSync(target);
    const existing = join(runner.cacheRoot, `${key}.git`);
    const cache = !free ? null : existsSync(existing) ? (refresh(runner, existing, plan.url) ? existing : null) : build(runner, runner.cacheRoot, key, plan.url);
    if (cache) {
      try { writeFileSync(join(cache, USED_STAMP), ""); } catch {}
      cloned = ok(run(runner, ["clone", ...plan.options, "--", cache, target], { stdio: ["ignore", "inherit", "inherit"] }));
      shared = cloned
        && ok(run(runner, ["-C", target, "fsck", "--connectivity-only", "--no-dangling", "--no-progress"], { stdio: "ignore" }))
        && ok(run(runner, ["-C", target, "remote", "set-url", plan.origin, plan.url]));
      if (shared) keepSharedPacks(target);
    }
  } finally {
    release();
  }
  if (shared) return { outcome: "shared", status: 0 };
  if (cloned) {
    if (existed) for (const name of readdirSync(target)) rmSync(join(target, name), { recursive: true, force: true });
    else rmSync(target, { recursive: true, force: true });
  }
  return plain();
}

function shared(cache: string): boolean {
  const packs = join(cache, "objects", "pack");
  let names: string[] = [];
  try { names = readdirSync(packs); } catch { return false; }
  return names.some((name) => {
    try { return name.endsWith(".pack") && lstatSync(join(packs, name)).nlink > 1; } catch { return false; }
  });
}

export function sweepUnsharedCaches(cacheRoot: string, now = Date.now()): { removed: string[]; freed: number } {
  const removed: string[] = [];
  let freed = 0;
  let names: string[] = [];
  try { names = readdirSync(cacheRoot); } catch { return { removed, freed }; }
  for (const name of names) {
    if (!name.endsWith(".git")) continue;
    const cache = join(cacheRoot, name);
    const release = takeLock(join(cacheRoot, `${name.slice(0, -4)}.lock`), 0);
    if (!release) continue;
    try {
      let used = 0;
      try { used = statSync(join(cache, USED_STAMP)).mtimeMs; } catch { try { used = statSync(cache).mtimeMs; } catch {} }
      if (shared(cache) || now - used < UNSHARED_CACHE_DAYS * 24 * 60 * 60_000) continue;
      const bytes = sizeOf(cache);
      rmSync(cache, { recursive: true, force: true });
      freed += bytes;
      removed.push(cache);
    } finally {
      release();
    }
  }
  return { removed, freed };
}
