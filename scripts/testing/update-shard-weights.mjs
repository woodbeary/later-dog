import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUTPUT = "scripts/testing/vitest-shard-weights.json";
const HEAVY_SECONDS = 5;
const E2E = /\.e2e\.test\.[cm]?[jt]s$/;
const LINUX_JOBS = /^(?:suite \d+\/\d+|vitest \((?:ubuntu-[\w.-]+, )?shard \d+\/\d+\))$/;
const WINDOWS_JOBS = /^vitest \(windows-[\w.-]+, shard \d+\/\d+\)$/;
const FILE_LINE =
  /\s[✓×❯↓] ((?:[\w.@-]+\/)+[\w.@-]+\.test\.[cm]?[jt]s)(?: \([^)]*\))?(?: (\d+)ms)?\s*$/;
// oxlint-disable-next-line no-control-regex -- strips colour codes from a CI log
const COLOUR = /(?:\u001b|\^\[)\[[\d;]*m/g;

export function parseVitestLog(text) {
  const seconds = new Map();
  for (const line of text.split("\n")) {
    const match = FILE_LINE.exec(line.replace(COLOUR, ""));
    if (match) seconds.set(match[1], Number(match[2] ?? 0) / 1000);
  }
  return seconds;
}

export function parseVitestJson(text, root = ROOT) {
  const seconds = new Map();
  for (const file of JSON.parse(text).testResults ?? []) {
    seconds.set(
      relative(root, file.name).split("\\").join("/"),
      (file.endTime - file.startTime) / 1000,
    );
  }
  return seconds;
}

export function buildWeights(samples, exists, previous = {}) {
  const seen = new Map();
  for (const sample of samples) {
    for (const [file, seconds] of sample) seen.set(file, [...(seen.get(file) ?? []), seconds]);
  }
  const weights = {};
  for (const file of [...new Set([...seen.keys(), ...Object.keys(previous)])].sort()) {
    if (!exists(file)) continue;
    const values = (seen.get(file) ?? [])
      .filter((seconds) => Number.isFinite(seconds) && seconds > 0)
      .sort((a, b) => a - b);
    if (values.length === 0) {
      if (Object.hasOwn(previous, file)) weights[file] = previous[file];
      continue;
    }
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    if (median >= HEAVY_SECONDS || E2E.test(file)) weights[file] = Math.max(1, Math.round(median));
  }
  return weights;
}

function github(...args) {
  return execFileSync("gh", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

export function collectRun(id, os = "linux", gh = github) {
  const pattern = os === "linux" ? LINUX_JOBS : os === "windows" ? WINDOWS_JOBS : undefined;
  if (!pattern) throw new Error(`unsupported platform ${os}; use linux or windows`);
  const shards = JSON.parse(gh("run", "view", id, "--json", "jobs")).jobs.filter((job) =>
    pattern.test(job.name),
  );
  if (shards.length === 0) throw new Error(`run ${id} has no ${os} vitest jobs`);
  return new Map(
    shards.flatMap((job) => {
      const timings = parseVitestLog(
        gh("api", `repos/{owner}/{repo}/actions/jobs/${job.databaseId}/logs`),
      );
      if (timings.size === 0) throw new Error(`run ${id} job ${job.name} has no file timings`);
      return [...timings];
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    options: { run: { type: "string", multiple: true }, os: { type: "string", default: "linux" } },
    allowPositionals: true,
  });
  if (!["linux", "windows"].includes(values.os))
    throw new Error(`unsupported platform ${values.os}; use linux or windows`);
  if (!values.run?.length && positionals.length === 0) {
    console.error(
      "usage: update-shard-weights.mjs [--os linux|windows] --run <ci run id> ... | <vitest log or json report> ...",
    );
    process.exit(2);
  }
  const samples = [
    ...(values.run ?? []).map((id) => collectRun(id, values.os)),
    ...positionals.map((file) =>
      (file.endsWith(".json") ? parseVitestJson : parseVitestLog)(readFileSync(file, "utf8")),
    ),
  ];
  const output = resolve(ROOT, OUTPUT);
  const previous = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : {};
  const weights = buildWeights(samples, (file) => existsSync(resolve(ROOT, file)), previous);
  writeFileSync(output, `${JSON.stringify(weights, null, 2)}\n`);
  console.log(`${OUTPUT}: ${Object.keys(weights).length} files from ${samples.length} samples`);
}
