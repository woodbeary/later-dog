import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { changedPushFiles, pushChecks } from "./check-push.mjs";

const zeros = "0".repeat(40);
const source = resolve(".");
const formatter = process.env.CI_FAST_TEST_OXFMT || resolve("node_modules/.bin/oxfmt");
const record = (head: string, base: string, name = "refs/heads/work") =>
  `${name} ${head} ${name} ${base}\n`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "laterdog-push-real-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const put = (name: string, body: string) => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), body);
  };
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Hook fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  put("src/changed.ts", "export const value = 1;\n");
  put(".oxlintrc.json", "{}\n");
  const base = commit();
  git("update-ref", "refs/remotes/origin/main", base);
  put("src/changed.ts", "export const value = 2;\n");
  return { root, git, put, commit, base, head: commit() };
}

describe("real pushed objects and bytes", () => {
  it("accepts annotated and lightweight HEAD tags together with a branch", () => {
    const f = fixture();
    f.git(
      "-c",
      "user.name=Hook fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "tag",
      "-am",
      "release",
      "annotated",
    );
    f.git("tag", "lightweight");
    const annotated = f.git("rev-parse", "refs/tags/annotated");
    const input =
      record(f.head, f.base) +
      record(annotated, zeros, "refs/tags/annotated") +
      record(f.head, zeros, "refs/tags/lightweight");
    expect(changedPushFiles(input, f.root)).toEqual(["src/changed.ts"]);
    expect(changedPushFiles(record(annotated, zeros, "refs/tags/annotated"), f.root)).toEqual([
      "src/changed.ts",
    ]);
  });

  it("rejects non-HEAD commits and tags that target blobs", () => {
    const f = fixture();
    expect(() => changedPushFiles(record(f.base, zeros), f.root)).toThrow(
      "check out the commit being pushed",
    );
    const blob = f.git("rev-parse", "HEAD:src/changed.ts");
    expect(() => changedPushFiles(record(blob, zeros, "refs/tags/blob"), f.root)).toThrow();
  });

  it.each(["--assume-unchanged", "--skip-worktree"])(
    "refuses hidden worktree bytes marked %s",
    (flag) => {
      const f = fixture();
      f.git("update-index", flag, "src/changed.ts");
      f.put("src/changed.ts", "export const value = 999;\n");
      expect(f.git("status", "--porcelain")).toBe("");
      expect(() => changedPushFiles(record(f.head, f.base), f.root)).toThrow(
        /assume-unchanged|skip-worktree/,
      );
    },
  );

  it.each(["unstaged", "staged", "both"])("refuses %s changed bytes", (state) => {
    const f = fixture();
    f.put("src/changed.ts", "export const value = 3;\n");
    if (state !== "unstaged") f.git("add", ".");
    if (state === "both") f.put("src/changed.ts", "export const value = 4;\n");
    expect(() => changedPushFiles(record(f.head, f.base), f.root)).toThrow(
      "commit or move local changes",
    );
  });

  it("refuses tracked symlinks instead of reading their mutable targets", () => {
    const f = fixture();
    symlinkSync(join(f.root, "src/changed.ts"), join(f.root, "src/linked.ts"));
    const head = f.commit();
    expect(() => changedPushFiles(record(head, f.base), f.root)).toThrow(/symlink|file mode/);
  });

  it("unions multiple ranges and keeps deleted config policy without reading deleted files", () => {
    const f = fixture();
    f.put("other.ts", "export const other = 1;\n");
    const other = f.commit();
    unlinkSync(join(f.root, ".oxlintrc.json"));
    f.put("third.ts", "export const third = 1;\n");
    const head = f.commit();
    const files = changedPushFiles(
      record(head, f.head) +
        record(head, other, "refs/heads/second") +
        `(delete) ${zeros} refs/heads/old ${f.base}\n`,
      f.root,
    );
    expect(files).toContain(".oxlintrc.json");
    expect(files).toContain("other.ts");
    expect(files).toContain("third.ts");
    const checks = pushChecks(files, new Set<string>(), f.root);
    expect(checks.find((check: { label: string }) => check.label === "lint")?.args).toEqual([
      "lint",
    ]);
    expect(checks.find((check: { label: string }) => check.label === "format")?.args).not.toContain(
      "./.oxlintrc.json",
    );
  });

  it("keeps renamed config invalidation and excludes deleted ordinary sources", () => {
    const f = fixture();
    renameSync(join(f.root, ".oxlintrc.json"), join(f.root, "old-config.json"));
    unlinkSync(join(f.root, "src/changed.ts"));
    const head = f.commit();
    const files = changedPushFiles(record(head, f.base), f.root);
    const checks = pushChecks(files, new Set<string>(), f.root);
    expect(checks.find((check: { label: string }) => check.label === "lint")?.args).toEqual([
      "lint",
    ]);
    expect(checks.find((check: { label: string }) => check.label === "format")?.args).not.toContain(
      "./src/changed.ts",
    );
  });

  it("fails closed for an unavailable remote object", () => {
    const f = fixture();
    expect(() => changedPushFiles(record(f.head, "1".repeat(40)), f.root)).toThrow();
  });

  it("uses the requested repository for the comment inventory", async () => {
    const f = fixture();
    f.put("only-here.sh", "#!/bin/sh\nexit 0\n");
    f.commit();
    const { trackedFiles } = await import("../no-comments.ts");
    expect(trackedFiles(f.root)).toContain("only-here.sh");
    expect(trackedFiles(source)).not.toContain("only-here.sh");
  });

  it("runs the actual shell comment classifier with canonical hook paths", () => {
    const f = fixture();
    f.put("scripts/git-hooks/pre-push", "#!/bin/sh\n# forbidden fixture comment\nexit 0\n");
    const check = pushChecks(
      ["scripts/git-hooks/pre-push"],
      new Set(["scripts/git-hooks/pre-push"]),
      f.root,
    ).find((item: { label: string }) => item.label === "comments");
    const result = spawnSync(
      process.execPath,
      [join(source, check.args[0]), ...check.args.slice(1)],
      { cwd: f.root, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout + result.stderr).toContain("comment");
  });
});

describe("real pinned formatter", () => {
  it.each([
    "literal[1].ts",
    "literal*.ts",
    "literal?.ts",
    "-leading.ts",
    "new\nline.ts",
    "settings.toml",
  ])("checks literal path %j and leaves bytes untouched", (name) => {
    const root = mkdtempSync(join(tmpdir(), "laterdog-format-real-"));
    const body = name.endsWith(".toml") ? "value=1\n" : "export const value={a:1}\n";
    writeFileSync(join(root, name), body);
    writeFileSync(join(root, ".oxfmtrc.json"), '{"sortPackageJson":false}\n');
    const result = spawnSync(formatter, ["--check", "--", `./${name}`], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("Format issues found");
    expect(readFileSync(join(root, name), "utf8")).toBe(body);
  });

  it("honors valid formatting config and rejects malformed config", () => {
    const root = mkdtempSync(join(tmpdir(), "laterdog-format-config-"));
    writeFileSync(join(root, "value.ts"), "export const value = 'yes'\n");
    writeFileSync(join(root, ".oxfmtrc.json"), '{"singleQuote":true,"semi":false}\n');
    expect(spawnSync(formatter, ["--check", "--", "./value.ts"], { cwd: root }).status).toBe(0);
    writeFileSync(join(root, ".oxfmtrc.json"), "{");
    expect(spawnSync(formatter, ["--check", "--", "./value.ts"], { cwd: root }).status).not.toBe(0);
  });
});

describe("shell record validation without Node", () => {
  const invoke = (input: string) => {
    const env = { ...process.env, PATH: "/usr/bin:/bin" };
    delete env.LATERDOG_SKIP_HOOKS;
    return spawnSync("sh", [join(source, "scripts/git-hooks/pre-push")], {
      input,
      env,
      encoding: "utf8",
    });
  };

  it("accepts complete legitimate deletion-only records", () => {
    expect(invoke(`(delete) ${zeros} refs/heads/old ${"1".repeat(40)}\n`).status).toBe(0);
  });

  it.each([
    `(delete) 0 refs/heads/old ${"1".repeat(40)}\n`,
    `(delete) ${zeros} refs/heads/old invalid\n`,
    `(delete) ${zeros} refs/heads/old ${"1".repeat(40)} extra\n`,
    `(delete) ${zeros} refs/heads/old ${"1".repeat(40)}`,
    `refs/heads/work ${"1".repeat(40)} refs/heads/work ${zeros}`,
  ])("rejects malformed or truncated record %j", (input) => {
    expect(invoke(input).status).not.toBe(0);
  });
});
