import { spawnSync } from "node:child_process";
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const output = resolve(process.env.CI_FAST_OUTPUT);
mkdirSync(output, { recursive: true });
const results = [];

function tests(label, files) {
  const log = openSync(join(output, `${label}.log`), "w");
  const start = performance.now();
  const child = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--maxWorkers=2", "--reporter=default", "--reporter=json", `--outputFile.json=${join(output, `${label}.json`)}`, ...files], { stdio: ["ignore", log, log] });
  closeSync(log);
  const data = JSON.parse(readFileSync(join(output, `${label}.json`), "utf8"));
  const result = { label, code: child.status, seconds: (performance.now() - start) / 1000, passed: data.numPassedTests, failed: data.numFailedTests, pending: data.numPendingTests };
  results.push(result);
  console.log(JSON.stringify(result));
  return result;
}

const before = tests("before", ["scripts/git-hooks/pre-push-fast.test.ts"]);
if (before.code !== 1 || before.failed !== 3 || before.passed !== 0 || before.pending !== 0) throw new Error("the original hook must fail all three behavioral probes");
writeFileSync("scripts/git-hooks/pre-push", readFileSync(".ci-fast-hook-lab/pre-push.after"));
const after = tests("after", ["scripts/git-hooks/pre-push-fast.test.ts", "scripts/git-hooks/check-push.test.ts", "scripts/git-hooks/pre-push.test.ts"]);
if (after.code !== 0 || after.failed !== 0 || after.passed !== 13 || after.pending !== 0) throw new Error("the changed-file hook must pass all thirteen checks");

const formatter = process.env.CI_FAST_OXFMT;
if (!formatter) throw new Error("missing pinned formatter path");
const probe = join(output, "format-probe.ts");
writeFileSync(probe, "export const value={answer:42};\n");
const formatChecks = [];
for (const args of [["--check", probe], ["--write", probe], ["--check", probe]]) {
  const start = performance.now();
  const child = spawnSync(formatter, args, { encoding: "utf8" });
  formatChecks.push({ args, code: child.status, signal: child.signal, seconds: (performance.now() - start) / 1000 });
  writeFileSync(join(output, `formatter-${formatChecks.length}.log`), (child.stdout ?? "") + (child.stderr ?? "") + (child.error?.message ?? ""));
}
const version = spawnSync(formatter, ["--version"], { encoding: "utf8" });
const summary = { node: process.version, head: process.env.GITHUB_SHA, results, formatter: version.stdout.trim(), formatChecks };
writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2));
if (formatChecks.map((result) => result.code).join(",") !== "1,0,0") throw new Error("formatter must reject bad format and accept its own output");
console.log(JSON.stringify(summary));
