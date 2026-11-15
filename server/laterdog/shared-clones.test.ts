import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloneShimEnvironment, realGit, shimScript } from "./clone-shim.ts";
import { cacheKey, cloneDirName, parseClone, sharedClone, sweepUnsharedCaches, takeLock } from "./shared-clones.ts";
import { makeSpace, pruneCaches } from "./space-maker.ts";

const GIT = realGit(process.env.PATH, "/nonexistent")!;
const quiet = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Dog", GIT_AUTHOR_EMAIL: "dog@example.test", GIT_COMMITTER_NAME: "Dog", GIT_COMMITTER_EMAIL: "dog@example.test" };
const env = { ...process.env, ...quiet };
const git = (cwd: string, ...args: string[]) => execFileSync(GIT, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let root: string;
let remote: string;
let url: string;
let cacheRoot: string;
let work: string;

function makeRemote(): void {
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "trunk");
  for (let index = 0; index < 3; index += 1) {
    writeFileSync(join(seed, `file-${index}.txt`), `${"history ".repeat(4000)}${index}\n`);
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", `step ${index}`);
  }
  git(seed, "tag", "v1");
  git(seed, "checkout", "-q", "-b", "side");
  writeFileSync(join(seed, "side.txt"), "side\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "side");
  git(seed, "checkout", "-q", "trunk");
  git(root, "clone", "-q", "--bare", seed, remote);
}

const clone = (...args: string[]) => sharedClone(["clone", ...args], { git: GIT, cacheRoot, cwd: work, env, lockWaitMs: 5_000 });
const packs = (repo: string) => readdirSync(join(repo, "objects", "pack")).filter((name) => name.endsWith(".pack")).map((name) => join(repo, "objects", "pack", name));
const whole = (dir: string) => execFileSync(GIT, ["-C", dir, "fsck", "--full", "--no-dangling"], { env, stdio: "ignore" });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shared-clones-"));
  remote = join(root, "remote.git");
  url = `file://${remote}`;
  cacheRoot = join(root, "home", ".cache", "laterdog-repos");
  work = join(root, "chat");
  mkdirSync(work, { recursive: true });
  makeRemote();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("reading a dog's git clone", () => {
  it("takes the plain forms and leaves every other form to git", () => {
    expect(parseClone(["clone", "https://example.test/a/b.git"])).toEqual({ url: "https://example.test/a/b.git", dir: null, options: [], origin: "origin" });
    expect(parseClone(["clone", "-b", "dev", "--single-branch", "git@example.test:a/b.git", "here"])).toMatchObject({ dir: "here", options: ["-b", "dev", "--single-branch"] });
    expect(parseClone(["clone", "--origin=up", "-q", "ssh://git@example.test/a/b"])).toMatchObject({ origin: "up", options: ["--origin", "up", "-q"] });
    for (const args of [
      ["clone", "--depth", "1", "https://example.test/a.git"], ["clone", "--filter=blob:none", "https://example.test/a.git"],
      ["clone", "--bare", "https://example.test/a.git"], ["clone", "--mirror", "https://example.test/a.git"],
      ["clone", "--reference", "/x", "https://example.test/a.git"], ["clone", "--recurse-submodules", "https://example.test/a.git"],
      ["clone", "/local/path/repo"], ["clone", "../sibling"], ["clone"], ["clone", "a", "b", "c"], ["status"],
    ]) expect(parseClone(args), args.join(" ")).toBeNull();
  });

  it("names the folder the way git does", () => {
    expect(cloneDirName("https://example.test/a/b.git")).toBe("b");
    expect(cloneDirName("https://example.test/a/b/")).toBe("b");
    expect(cloneDirName("git@example.test:a/b.git")).toBe("b");
    expect(cloneDirName("ssh://git@example.test:22/a/b.git/")).toBe("b");
    expect(cloneDirName("https://example.test/a/b/.git")).toBe("b");
  });

  it("keys one cache per remote, never by the credentials in the address", () => {
    const key = cacheKey("https://example.test/a/b.git");
    expect(cacheKey("https://dog:secret-token@Example.test/a/b")).toBe(key);
    expect(cacheKey("https://example.test/a/b/")).toBe(key);
    expect(cacheKey("https://example.test/a/c")).not.toBe(key);
    expect(cacheKey("https://dog:secret-token@example.test/a/b")).not.toMatch(/secret/);
  });
});

describe("one copy of a repository's history", () => {
  it("gives each clone a whole work copy that looks like a plain clone and shares the history on disk", () => {
    expect(clone(url, "one")).toEqual({ outcome: "shared", status: 0 });
    expect(clone(url, "two")).toEqual({ outcome: "shared", status: 0 });
    for (const name of ["one", "two"]) {
      const dir = join(work, name);
      whole(dir);
      expect(git(dir, "remote", "get-url", "origin")).toBe(url);
      expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("trunk");
      expect(git(dir, "branch", "-r").split("\n").map((line) => line.trim())).toEqual(expect.arrayContaining(["origin/trunk", "origin/side"]));
      expect(git(dir, "tag")).toBe("v1");
      expect(existsSync(join(dir, ".git", "objects", "info", "alternates"))).toBe(false);
    }
    const cache = join(cacheRoot, `${cacheKey(url)}.git`);
    expect(packs(cache).length).toBeGreaterThan(0);
    for (const pack of packs(cache)) expect(lstatSync(pack).nlink).toBe(3);
    expect(git(cache, "symbolic-ref", "HEAD")).toBe("refs/heads/trunk");
  });

  it("keeps the work copies whole when the cache is removed, and after a dog's gc", () => {
    clone(url, "one");
    clone(url, "two");
    rmSync(cacheRoot, { recursive: true, force: true });
    git(join(work, "one"), "gc", "--aggressive", "--prune=now");
    whole(join(work, "one"));
    whole(join(work, "two"));
    expect(git(join(work, "two"), "log", "--oneline").split("\n")).toHaveLength(3);
  });

  it("keeps the shared history shared through a dog's gc", () => {
    clone(url, "one");
    clone(url, "two");
    git(join(work, "one"), "gc", "--prune=now");
    expect(packs(join(work, "one", ".git")).some((pack) => lstatSync(pack).nlink > 1)).toBe(true);
  });

  it("brings in new work from the remote on the next clone", () => {
    clone(url, "one");
    const seed = join(root, "seed");
    writeFileSync(join(seed, "later.txt"), "later\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "later");
    git(seed, "push", "-q", remote, "trunk");
    expect(clone(url, "two").outcome).toBe("shared");
    expect(git(join(work, "two"), "log", "--oneline", "-1")).toMatch(/later/);
  });

  it("follows -b and -o like git", () => {
    expect(clone("-b", "side", "-o", "up", url, "three").outcome).toBe("shared");
    const dir = join(work, "three");
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("side");
    expect(git(dir, "remote", "get-url", "up")).toBe(url);
  });

  it("falls back to a plain clone when the cache is missing an object, leaving nothing half made", () => {
    clone(url, "one");
    const cache = join(cacheRoot, `${cacheKey(url)}.git`);
    for (const pack of packs(cache)) rmSync(pack);
    for (const name of readdirSync(join(cache, "objects", "pack"))) rmSync(join(cache, "objects", "pack", name));
    git(cache, "update-ref", "refs/heads/trunk", git(join(work, "one"), "rev-parse", "HEAD"));
    const seed = join(root, "seed");
    writeFileSync(join(seed, "more.txt"), "more\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "more");
    git(seed, "push", "-q", remote, "trunk");
    const result = clone(url, "two");
    whole(join(work, "two"));
    expect(result.status).toBe(0);
    expect(git(join(work, "two"), "log", "--oneline", "-1")).toMatch(/more/);
  });

  it("ignores a half-written cache from a clone that died and builds a whole one", () => {
    mkdirSync(cacheRoot, { recursive: true });
    const torn = join(cacheRoot, `${cacheKey(url)}.tmp-99999-dead`);
    mkdirSync(torn);
    writeFileSync(join(torn, "HEAD"), "garbage");
    expect(clone(url, "one").outcome).toBe("shared");
    whole(join(work, "one"));
    expect(existsSync(torn)).toBe(false);
  });

  it("writes no credentials into the cache", () => {
    clone(url, "one");
    const cache = join(cacheRoot, `${cacheKey(url)}.git`);
    expect(readFileSync(join(cache, "config"), "utf8")).not.toMatch(/remote|url/);
    expect(existsSync(join(cache, "FETCH_HEAD"))).toBe(false);
  });

  it("hands every other form to git untouched", () => {
    expect(clone("--depth", "1", url, "shallow")).toEqual({ outcome: "plain", status: 0 });
    expect(existsSync(cacheRoot)).toBe(false);
    expect(git(join(work, "shallow"), "rev-parse", "--is-shallow-repository")).toBe("true");
  });

  it("leaves a folder that already has files to git's own refusal", () => {
    mkdirSync(join(work, "taken"));
    writeFileSync(join(work, "taken", "mine.txt"), "mine\n");
    expect(clone(url, "taken").outcome).toBe("plain");
    expect(readFileSync(join(work, "taken", "mine.txt"), "utf8")).toBe("mine\n");
  });

  it("takes over a lock whose owner is gone and waits for a live one", () => {
    const lock = join(root, "x.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "999999");
    const release = takeLock(lock, 0);
    expect(release).not.toBeNull();
    expect(takeLock(lock, 300)).toBeNull();
    release!();
    expect(existsSync(lock)).toBe(false);
  });
});

describe("removing a cache no clone shares", () => {
  it("keeps a cache while any work copy shares it, and removes it a week after the last one stops", () => {
    clone(url, "one");
    const cache = join(cacheRoot, `${cacheKey(url)}.git`);
    const old = Date.now() - 8 * 24 * 60 * 60_000;
    utimesSync(join(cache, "laterdog-used"), old / 1000, old / 1000);
    expect(sweepUnsharedCaches(cacheRoot).removed).toEqual([]);
    rmSync(join(work, "one"), { recursive: true, force: true });
    const swept = sweepUnsharedCaches(cacheRoot, Date.now());
    expect(swept.removed).toEqual([cache]);
    expect(swept.freed).toBeGreaterThan(0);
  });

  it("is never touched by the cleaners of build output and package caches", () => {
    const home = join(root, "home");
    clone(url, "one");
    rmSync(join(work, "one"), { recursive: true, force: true });
    const before = readdirSync(cacheRoot);
    makeSpace({ home, workspacesDir: join(root, "task-workspaces"), busyDirs: [], processes: () => [] });
    pruneCaches({ home, processes: () => [], pruneStore: () => {} });
    expect(readdirSync(cacheRoot)).toEqual(before);
    expect(sweepUnsharedCaches(cacheRoot).removed).toEqual([]);
  });

  it("keeps an unshared cache used this week", () => {
    clone(url, "one");
    rmSync(join(work, "one"), { recursive: true, force: true });
    expect(sweepUnsharedCaches(cacheRoot).removed).toEqual([]);
  });
});

describe("the git on an engine's path", () => {
  it("puts its own git first and finds the real one behind it", () => {
    const shimDir = join(root, "engine-bin");
    const path = `${shimDir}:${process.env.PATH}`;
    const added = cloneShimEnvironment(path, shimDir, process.execPath, "/helper.js");
    expect(added.PATH?.split(":")[0]).toBe(shimDir);
    expect(added.PATH?.split(":").filter((dir) => dir === shimDir)).toHaveLength(1);
    expect(realGit(added.PATH, shimDir)).toBe(GIT);
    expect(readFileSync(join(shimDir, "git"), "utf8")).toBe(shimScript(GIT, process.execPath, "/helper.js"));
  });

  it("passes everything but clone straight to git, and clone to the helper", () => {
    const shimDir = join(root, "engine-bin");
    const helper = join(root, "helper.mjs");
    writeFileSync(helper, "console.log('helper', process.env.LATERDOG_REAL_GIT, process.argv.slice(2).join(' '))\n");
    cloneShimEnvironment(process.env.PATH, shimDir, process.execPath, helper);
    expect(execFileSync(join(shimDir, "git"), ["--version"], { encoding: "utf8" })).toMatch(/^git version/);
    expect(execFileSync(join(shimDir, "git"), ["clone", "x"], { encoding: "utf8" }).trim()).toBe(`helper ${GIT} clone x`);
  });

  it("does nothing when no git is on the path", () => {
    expect(cloneShimEnvironment("/nowhere", join(root, "engine-bin"), process.execPath, "/helper.js")).toEqual({});
  });

  it("lets two dogs clone the same remote at once", async () => {
    const shimDir = join(root, "engine-bin");
    const helper = join(import.meta.dirname, "shared-clone-cli.ts");
    const { PATH } = cloneShimEnvironment(process.env.PATH, shimDir, process.execPath, helper);
    const run = (name: string) => new Promise<number>((done) => {
      const child = spawn("git", ["clone", "-q", url, name], { cwd: work, env: { ...env, PATH, LATERDOG_REPO_CACHE: cacheRoot }, stdio: "ignore" });
      child.on("exit", (code) => done(code ?? 1));
    });
    expect(await Promise.all([run("a"), run("b")])).toEqual([0, 0]);
    whole(join(work, "a"));
    whole(join(work, "b"));
    const cache = join(cacheRoot, `${cacheKey(url)}.git`);
    expect(packs(cache).length).toBeGreaterThan(0);
    for (const pack of packs(cache)) expect(lstatSync(pack).nlink).toBe(3);
  }, 30_000);
});
