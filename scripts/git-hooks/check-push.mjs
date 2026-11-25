import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { trackedFiles } from "../no-comments.ts";

const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const ZERO = /^0+$/;
const FORMAT = /\.(?:[cm]?[jt]sx?|jsonc?|json5|css|scss|less|html|vue|mdx?|ya?ml|toml|graphql|gql)$/;
const LINT = /\.[cm]?[jt]sx?$/;
const LINT_CONFIG = /^(?:\.oxlintrc\.json|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/;
const BUDGET_SECONDS = 9;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

export function changedPushFiles(input, cwd = process.cwd(), runGit = git) {
  const refs = input.split(/\r?\n/).filter(Boolean).map((line) => {
    const fields = line.split(/\s+/);
    if (fields.length !== 4 || !SHA.test(fields[1]) || !SHA.test(fields[3])) throw new Error("invalid pushed ref record");
    return { local: fields[1], remote: fields[3] };
  }).filter((ref) => !ZERO.test(ref.local));
  if (!refs.length) return [];
  const head = runGit(["rev-parse", "HEAD"], cwd).trim();
  if (refs.some((ref) => ref.local !== head)) throw new Error("check out the commit being pushed before checking it");
  if (runGit(["status", "--porcelain=v1", "--untracked-files=all"], cwd).trim()) throw new Error("commit or move local changes before checking the pushed commit");
  const files = new Set();
  for (const ref of refs) {
    const base = ZERO.test(ref.remote) ? runGit(["merge-base", head, "origin/main"], cwd).trim() : ref.remote;
    if (!SHA.test(base)) throw new Error("cannot find the pushed branch's base commit");
    const paths = runGit(["diff", "--name-only", "-z", "--diff-filter=ACMRT", "--no-renames", base, ref.local, "--"], cwd);
    for (const file of paths.split("\0")) if (file) files.add(file);
  }
  return [...files].sort();
}

export function pushChecks(files, commentFiles) {
  const formatted = files.filter((file) => FORMAT.test(file)).map((file) => `./${file}`);
  const linted = files.filter((file) => LINT.test(file)).map((file) => `./${file}`);
  const comments = files.filter((file) => commentFiles.has(file)).map((file) => `./${file}`);
  return [
    ...(formatted.length ? [{ label: "format", command: "pnpm", args: ["exec", "oxfmt", "--check", "--", ...formatted] }] : []),
    ...(comments.length ? [{ label: "comments", command: "node", args: ["scripts/no-comments.ts", "--check", ...comments] }] : []),
    ...(files.some((file) => LINT_CONFIG.test(file))
      ? [{ label: "lint", command: "pnpm", args: ["lint"] }]
      : linted.length ? [{ label: "lint", command: "pnpm", args: ["exec", "oxlint", "--deny-warnings", "--", ...linted] }] : []),
    { label: "typecheck", command: "pnpm", args: ["typecheck"] },
    { label: "locale", command: "pnpm", args: ["i18n:check"] },
  ];
}

export async function runPushChecks(checks, cwd = process.cwd()) {
  return Promise.all(checks.map((check) => new Promise((done) => {
    const child = spawn(check.command, check.args, { cwd, stdio: "inherit" });
    child.once("error", (error) => done({ label: check.label, error: error.message }));
    child.once("close", (code, signal) => done({ label: check.label, error: signal ? `signal ${signal}` : code === 0 ? null : `exit code ${code}` }));
  })));
}

export async function checkPush(input, cwd = process.cwd()) {
  const start = performance.now();
  const files = changedPushFiles(input, cwd);
  const comments = new Set(trackedFiles());
  const results = await runPushChecks(pushChecks(files, comments), cwd);
  const seconds = (performance.now() - start) / 1000;
  const failures = results.filter((result) => result.error);
  for (const result of failures) process.stderr.write(`pre-push: ${result.label} failed with ${result.error}\n`);
  if (seconds > BUDGET_SECONDS) process.stderr.write(`pre-push: ${seconds.toFixed(2)}s exceeds the ${BUDGET_SECONDS}s budget\n`);
  process.stdout.write(`pre-push: ${files.length} changed files checked in ${seconds.toFixed(2)}s\n`);
  return failures.length || seconds > BUDGET_SECONDS ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await checkPush(readFileSync(0, "utf8")); }
  catch (error) { process.stderr.write(`pre-push: ${error.message}\n`); process.exitCode = 1; }
}
