import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type Mode =
  | "stable"
  | "outdated"
  | "package-tracked"
  | "package-head"
  | "late-tracked"
  | "late-main";
type Event = { tool: string; args: string[] };

const directories: string[] = [];
const stub = String.raw`import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [tool, ...args] = process.argv.slice(2);
const repo = process.env.FIXTURE_REPO;
const mode = process.env.FIXTURE_MODE;
appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({ tool, args }) + "\n");
const write = (name, text, executable = false) => {
  const target = join(repo, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  if (executable) chmodSync(target, 0o755);
};
const git = (cwd, values) => {
  const result = spawnSync("git", values, { cwd, env: process.env, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(String(result.error || result.stderr));
};
if (tool === "bun") {
  if (args[0] !== "run") throw new Error("Unexpected Bun command");
  if (args[1] === "laterdog:package") {
    const app = "release/mac-arm64/later.dog.app/Contents/";
    write(app + "Info.plist", "fixture plist");
    write(app + "Resources/server/laterdog/main.js", "");
    write(app + "Resources/server/laterdog/mcp.js", "");
    write(app + "Resources/licenses/later.dog-NOTICE.txt", "fixture notice");
    write(app + "Resources/later.dog Speech.app/Contents/MacOS/speech-helper", "#!/bin/sh\nexit 0\n", true);
    write(app + "Resources/app-update.yml", "updaterCacheDirName: fixture-updater\n");
    write(app + "MacOS/later.dog", "#!/bin/sh\nprintf '%s\\n' \"$LATERDOG_UPDATE_FEED\"\n", true);
    if (mode === "package-tracked") appendFileSync(join(repo, "tracked.txt"), "package changed source\n");
    if (mode === "package-head") git(repo, ["checkout", "--quiet", "--detach", process.env.FIXTURE_NEXT]);
  } else if (args[1] === "electron-builder") {
    write("release/later.dog-macOS-arm64.dmg", "fixture disk image bytes");
  } else if (args[1] !== "test:packaged-server") {
    throw new Error("Unexpected Bun script: " + args[1]);
  }
} else if (tool === "security") {
  console.log('1) ABCDEF "Developer ID Application: Fixture (TEAM123456)"');
} else if (tool === "codesign") {
  if (args.includes("-dr")) console.error('designated => anchor apple generic and certificate leaf[subject.OU] = "TEAM123456"');
  if (args.includes("--force")) {
    if (mode === "late-tracked") appendFileSync(join(repo, "tracked.txt"), "late source change\n");
    if (mode === "late-main") git(process.env.FIXTURE_ORIGIN, ["update-ref", "refs/heads/main", process.env.FIXTURE_NEXT]);
  }
} else if (tool === "fixture-plistbuddy") {
  console.log(args.includes("Print :CFBundleShortVersionString") ? "0.3.49" : "dog.later.app");
} else if (tool === "ditto") {
  writeFileSync(args[args.length - 1], "fixture zip bytes");
} else if (tool === "xcrun") {
  if (args[0] === "notarytool" && args[1] === "submit") {
    console.log(JSON.stringify({ id: "fixture-notary", status: "Accepted" }));
  } else if (args[0] !== "stapler") {
    throw new Error("Unexpected xcrun command");
  }
} else if (tool === "gh") {
  if (args[0] === "release" && args[1] === "view") process.exit(1);
  if (args[0] !== "release" || args[1] !== "create") throw new Error("Unexpected gh command");
  writeFileSync(process.env.FIXTURE_PUBLICATION, "fixture publication boundary\n");
} else if (tool !== "hdiutil" && tool !== "spctl") {
  throw new Error("Unexpected external command: " + tool);
}
`;

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function fixture(mode: Mode, dryRun = false) {
  const directory = mkdtempSync(join(tmpdir(), "laterdog-release-mac-"));
  directories.push(directory);
  const repo = join(directory, "repo");
  const origin = join(directory, "origin.git");
  const home = join(directory, "home");
  const bin = join(directory, "bin");
  const temporary = join(directory, "tmp");
  const events = join(directory, "events.jsonl");
  const publication = join(directory, "publication");
  for (const path of [repo, home, bin, temporary]) mkdirSync(path, { recursive: true });
  writeFileSync(join(home, ".gitconfig"), "");
  const env: NodeJS.ProcessEnv = {
    PATH: bin + ":" + (process.env.PATH || ""),
    HOME: home,
    TMPDIR: temporary,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Release Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Release Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    APPLE_API_KEY_ID: "FIXTURE0001",
    APPLE_API_ISSUER: "synthetic-fixture-issuer",
    LATERDOG_RELEASE_REPO: "fixture/later-dog",
    LATERDOG_RELEASE_DRY_RUN: dryRun ? "1" : "0",
    LATERDOG_RELEASE_ACCEPT_GONE: "",
    LATERDOG_VARIANT: "release",
    GH_CONFIG_DIR: join(home, "gh"),
    FIXTURE_REPO: repo,
    FIXTURE_ORIGIN: origin,
    FIXTURE_MODE: mode,
    FIXTURE_EVENTS: events,
    FIXTURE_PUBLICATION: publication,
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 5000 });
    if (result.error || result.status !== 0) throw new Error(String(result.error || result.stderr));
    return result.stdout.trim();
  };
  const write = (name: string, text: string) => {
    const target = join(repo, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  const release = readFileSync(new URL("./laterdog-release-mac.sh", import.meta.url), "utf8");
  write(
    "scripts/laterdog-release-mac.sh",
    release.replaceAll("/usr/libexec/PlistBuddy", "fixture-plistbuddy"),
  );
  for (const name of [
    "scripts/laterdog-release-files.mjs",
    "scripts/release-file-list.mjs",
    "electron/update-feed.mjs",
  ]) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    copyFileSync(new URL("../" + name, import.meta.url), join(repo, name));
  }
  write("package.json", JSON.stringify({ type: "module", version: "0.3.49" }));
  write("CHANGELOG.md", "# Changelog\n\n## 0.3.49 — 2026-11-25\n\n- Fixture release.\n");
  write("tracked.txt", "checked source\n");
  writeFileSync(join(directory, "stub.mjs"), stub);
  const launcher =
    "#!/bin/sh\nexec " +
    shellQuote(process.execPath) +
    " " +
    shellQuote(join(directory, "stub.mjs")) +
    " ";
  for (const tool of [
    "bun",
    "security",
    "codesign",
    "fixture-plistbuddy",
    "ditto",
    "xcrun",
    "hdiutil",
    "spctl",
    "gh",
  ]) {
    const target = join(bin, tool);
    writeFileSync(target, launcher + shellQuote(tool) + ' "$@"\n');
    chmodSync(target, 0o755);
  }
  writeFileSync(join(bin, "node"), "#!/bin/sh\nexec " + shellQuote(process.execPath) + ' "$@"\n');
  chmodSync(join(bin, "node"), 0o755);
  const key = join(home, ".appstoreconnect/private_keys/AuthKey_FIXTURE0001.p8");
  mkdirSync(dirname(key), { recursive: true });
  writeFileSync(key, "synthetic fixture key, not a real credential\n");
  const previous = join(directory, "previous-files.txt");
  writeFileSync(
    previous,
    "later.dog.app/Contents/MacOS/later.dog\nlater.dog.app/Contents/Resources/server/laterdog/main.js\n",
  );
  env.LATERDOG_PREVIOUS_FILES = previous;
  git(directory, "init", "--bare", "--initial-branch=main", origin);
  git(repo, "init", "--initial-branch=main");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "Fixture checked source");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  appendFileSync(join(repo, "tracked.txt"), "next source\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "--quiet", "-m", "Fixture newer source");
  const next = git(repo, "rev-parse", "HEAD");
  git(repo, "push", "--quiet", "origin", "HEAD:refs/heads/fixture-next");
  git(repo, "checkout", "--quiet", "--detach", base);
  if (mode === "outdated") {
    git(origin, "update-ref", "refs/heads/main", next);
    git(repo, "fetch", "--quiet", "origin", "refs/heads/main:refs/remotes/origin/main");
  }
  env.FIXTURE_NEXT = next;
  const result = spawnSync("bash", ["scripts/laterdog-release-mac.sh", "v0.3.49"], {
    cwd: repo,
    env,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  const observed: Event[] = existsSync(events)
    ? readFileSync(events, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  const evidence = process.env.LATERDOG_RELEASE_FIXTURE_EVIDENCE;
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(
      join(evidence, mode + (dryRun ? "-dry-run" : "") + ".json"),
      JSON.stringify(
        {
          base,
          next,
          status: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
          events: observed,
          published: existsSync(publication),
        },
        null,
        2,
      ) + "\n",
    );
  }
  return {
    result,
    events: observed,
    published: existsSync(publication),
    packages: observed.filter(
      (event) => event.tool === "bun" && event.args[1] === "laterdog:package",
    ),
    packagedChecks: observed.filter(
      (event) => event.tool === "bun" && event.args[1] === "test:packaged-server",
    ),
    notarizations: observed.filter(
      (event) =>
        event.tool === "xcrun" && event.args[0] === "notarytool" && event.args[1] === "submit",
    ),
    publications: observed.filter(
      (event) => event.tool === "gh" && event.args[0] === "release" && event.args[1] === "create",
    ),
  };
}

describe("Mac release source identity", () => {
  it("rejects an older ancestor of current main before packaging", () => {
    const run = fixture("outdated");
    expect(run.result.status, run.result.stderr).toBe(1);
    expect(run.result.stderr).toContain("match origin/main exactly");
    expect(run.packages).toHaveLength(0);
    expect(run.notarizations).toHaveLength(0);
    expect(run.published).toBe(false);
  });

  it("rejects tracked source changed by packaging before notarization", () => {
    const run = fixture("package-tracked");
    expect(run.result.status, run.result.stderr).toBe(1);
    expect(run.result.stderr).toContain("tracked changes");
    expect(run.packages).toHaveLength(1);
    expect(run.packagedChecks).toHaveLength(1);
    expect(run.notarizations).toHaveLength(0);
    expect(run.published).toBe(false);
  });

  it("rejects a clean HEAD changed by packaging before notarization", () => {
    const run = fixture("package-head");
    expect(run.result.status, run.result.stderr).toBe(1);
    expect(run.result.stderr).toContain("Release source must stay at");
    expect(run.packages).toHaveLength(1);
    expect(run.packagedChecks).toHaveLength(1);
    expect(run.notarizations).toHaveLength(0);
    expect(run.published).toBe(false);
  });

  it("rejects tracked source changed later before publication", () => {
    const run = fixture("late-tracked");
    expect(run.result.status, run.result.stderr).toBe(1);
    expect(run.result.stderr).toContain("tracked changes");
    expect(run.notarizations).toHaveLength(2);
    expect(run.publications).toHaveLength(0);
    expect(run.published).toBe(false);
  });

  it("fetches main again before publication and rejects a newer commit", () => {
    const run = fixture("late-main");
    expect(run.result.status, run.result.stderr).toBe(1);
    expect(run.result.stderr).toContain("match origin/main exactly");
    expect(run.notarizations).toHaveLength(2);
    expect(run.publications).toHaveLength(0);
    expect(run.published).toBe(false);
  });

  it("rejects late tracked changes before returning a successful dry run", () => {
    const run = fixture("late-tracked", true);
    expect(run.result.status, run.result.stderr).toBe(1);
    expect(run.result.stderr).toContain("tracked changes");
    expect(run.notarizations).toHaveLength(2);
    expect(run.result.stdout).not.toContain("Dry run: built and notarized");
    expect(run.published).toBe(false);
  });

  it("lets stable source reach the stubbed publication boundary", () => {
    const run = fixture("stable");
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.packages).toHaveLength(1);
    expect(run.packagedChecks).toHaveLength(1);
    expect(run.notarizations).toHaveLength(2);
    expect(run.publications).toHaveLength(1);
    expect(run.published).toBe(true);
  });
});
