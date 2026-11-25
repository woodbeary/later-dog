import { execFileSync, spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { trackedFiles } from "../no-comments.ts";

const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const ZERO = /^0+$/;
const FORMAT =
  /\.(?:[cm]?[jt]sx?|jsonc?|json5|css|scss|less|html|vue|mdx?|ya?ml|toml|graphql|gql)$/;
const LINT = /\.[cm]?[jt]sx?$/;
const LINT_CONFIG =
  /(?:^|\/)(?:\.oxlintrc\.jsonc?|oxlint\.config\.[cm]?[jt]s|package\.json)$|^(?:pnpm-lock\.yaml|pnpm-workspace\.yaml)$/;
const COMMENT_CONFIG = /^scripts\/no-comments(?:-config)?\.ts$/;
const BUDGET_SECONDS = 9;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

export function changedPushFiles(input, cwd = process.cwd(), runGit = git) {
  if (input && !input.endsWith("\n")) throw new Error("invalid unterminated pushed ref record");
  const refs = input
    .split("\n")
    .slice(0, -1)
    .map((line) => {
      const fields = line.split(" ");
      const remote = fields[2];
      const validRemote =
        remote?.startsWith("refs/") &&
        !remote.endsWith("/") &&
        !remote.endsWith(".") &&
        !remote.includes("..") &&
        !remote.includes("@{") &&
        !Array.from(remote).some(
          (character) =>
            character.charCodeAt(0) <= 32 ||
            character.charCodeAt(0) === 127 ||
            "~^:?*[\\".includes(character),
        ) &&
        remote.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));
      if (
        fields.length !== 4 ||
        !fields[0] ||
        !SHA.test(fields[1]) ||
        !SHA.test(fields[3]) ||
        fields[1].length !== fields[3].length ||
        !validRemote ||
        ZERO.test(fields[1]) !== (fields[0] === "(delete)") ||
        (ZERO.test(fields[1]) && ZERO.test(fields[3]))
      )
        throw new Error("invalid pushed ref record");
      return { local: fields[1], remote: fields[3] };
    })
    .filter((ref) => !ZERO.test(ref.local));
  if (!refs.length) return [];
  const head = runGit(["rev-parse", "HEAD"], cwd).trim();
  for (const ref of refs) {
    if (runGit(["rev-parse", "--verify", `${ref.local}^{commit}`], cwd).trim() !== head)
      throw new Error("check out the commit being pushed before checking it");
  }
  if (runGit(["status", "--porcelain=v1", "--untracked-files=all"], cwd).trim())
    throw new Error("commit or move local changes before checking the pushed commit");
  const flags = runGit(["ls-files", "-v", "-z"], cwd).split("\0").filter(Boolean);
  if (flags.some((entry) => entry[0] === "S" || /[a-z]/.test(entry[0])))
    throw new Error(
      "clear assume-unchanged and skip-worktree flags before checking the pushed commit",
    );
  const tracked = runGit(["ls-files", "--stage", "-z"], cwd).split("\0").filter(Boolean);
  for (const entry of tracked) {
    const match = entry.match(/^(100644|100755) [a-f0-9]+ 0\t([\s\S]+)$/);
    if (!match || !lstatSync(resolve(cwd, match[2])).isFile())
      throw new Error("unsupported tracked symlink or file mode in pushed checkout");
  }
  const files = new Set();
  for (const ref of refs) {
    const base = ZERO.test(ref.remote)
      ? runGit(["merge-base", head, "origin/main"], cwd).trim()
      : ref.remote;
    if (!SHA.test(base)) throw new Error("cannot find the pushed branch's base commit");
    const paths = runGit(
      ["diff", "--name-only", "-z", "--diff-filter=ACDMRT", "--no-renames", base, ref.local, "--"],
      cwd,
    );
    for (const file of paths.split("\0")) if (file) files.add(file);
  }
  return [...files].sort();
}

export function pushChecks(files, commentFiles, cwd = process.cwd()) {
  const present = files.filter((file) => {
    try {
      return lstatSync(resolve(cwd, file)).isFile();
    } catch {
      return false;
    }
  });
  const formatted = present.filter((file) => FORMAT.test(file)).map((file) => `./${file}`);
  const linted = present.filter((file) => LINT.test(file)).map((file) => `./${file}`);
  const comments = present
    .filter((file) => commentFiles.has(file))
    .map((file) => (file.startsWith("-") ? `./${file}` : file));
  const allComments = files.some((file) => COMMENT_CONFIG.test(file));
  return [
    ...(formatted.length
      ? [
          {
            label: "format",
            command: "pnpm",
            args: ["exec", "oxfmt", "--check", "--", ...formatted],
          },
        ]
      : []),
    ...(allComments || comments.length
      ? [
          {
            label: "comments",
            command: "node",
            args: ["scripts/no-comments.ts", "--check", ...(allComments ? [] : comments)],
          },
        ]
      : []),
    ...(files.some((file) => LINT_CONFIG.test(file))
      ? [{ label: "lint", command: "pnpm", args: ["lint"] }]
      : linted.length
        ? [
            {
              label: "lint",
              command: "pnpm",
              args: ["exec", "oxlint", "--deny-warnings", "--", ...linted],
            },
          ]
        : []),
    { label: "typecheck", command: "pnpm", args: ["typecheck"] },
    { label: "locale", command: "pnpm", args: ["i18n:check"] },
  ];
}

export async function runPushChecks(checks, cwd = process.cwd()) {
  return Promise.all(
    checks.map(
      (check) =>
        new Promise((done) => {
          try {
            const child = spawn(check.command, check.args, { cwd, stdio: "inherit" });
            child.once("error", (error) => done({ label: check.label, error: error.message }));
            child.once("close", (code, signal) =>
              done({
                label: check.label,
                error: signal ? `signal ${signal}` : code === 0 ? null : `exit code ${code}`,
              }),
            );
          } catch (error) {
            done({ label: check.label, error: error.message });
          }
        }),
    ),
  );
}

export function finishPushChecks(
  results,
  seconds,
  fileCount,
  stdout = process.stdout,
  stderr = process.stderr,
) {
  const failures = results.filter((result) => result.error);
  for (const result of failures)
    stderr.write(`pre-push: ${result.label} failed with ${result.error}\n`);
  if (seconds > BUDGET_SECONDS)
    stderr.write(`pre-push: ${seconds.toFixed(2)}s exceeds the ${BUDGET_SECONDS}s budget\n`);
  stdout.write(`pre-push: ${fileCount} changed files checked in ${seconds.toFixed(2)}s\n`);
  return failures.length || seconds > BUDGET_SECONDS ? 1 : 0;
}

export async function checkPush(input, cwd = process.cwd()) {
  const start = performance.now();
  const files = changedPushFiles(input, cwd);
  const comments = new Set(trackedFiles(cwd));
  const results = await runPushChecks(pushChecks(files, comments, cwd), cwd);
  const seconds = (performance.now() - start) / 1000;
  return finishPushChecks(results, seconds, files.length);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await checkPush(readFileSync(0, "utf8"));
  } catch (error) {
    process.stderr.write(`pre-push: ${error.message}\n`);
    process.exitCode = 1;
  }
}
