import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SHARDS = 8;
export const EDGE_DIR = "deploy/laterdog/home";

export function gateSteps(shards = SHARDS) {
  return [
    { name: "typecheck", kind: "check", command: ["pnpm", "typecheck"] },
    { name: "lint", kind: "check", command: ["pnpm", "lint"] },
    { name: "electron", kind: "check", command: ["pnpm", "test:electron"] },
    ...Array.from({ length: shards }, (_, index) => ({
      name: `suite ${index + 1}/${shards}`, kind: "vitest", command: ["pnpm", "exec", "vitest", "run", `--shard=${index + 1}/${shards}`],
    })),
    { name: "edge", kind: "vitest", cwd: EDGE_DIR, needs: join(EDGE_DIR, "node_modules"), command: ["pnpm", "exec", "vitest", "run"] },
  ];
}

export function selectSteps(steps, argv) {
  const at = argv.indexOf("--only");
  if (at === -1) return { steps, partial: false };
  const value = argv[at + 1];
  if (!value || value.startsWith("--")) return { error: "--only needs step names separated by commas" };
  const names = value.split(",").map((name) => name.trim()).filter(Boolean);
  const matches = (name, step) => step.name === name || (name === "suite" && step.name.startsWith("suite "));
  const unknown = names.filter((name) => !steps.some((step) => matches(name, step)));
  if (!names.length || unknown.length) return { error: `unknown step${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ") || value}; steps are ${steps.map((step) => step.name).join(", ")}, or suite for all its parts` };
  return { steps: steps.filter((step) => names.some((name) => matches(name, step))), partial: true };
}

export function wrapperFrom(value) {
  return (value ?? "").trim().split(/\s+/).filter(Boolean);
}

export function failingFiles(log) {
  const files = new Set();
  for (const line of log.split("\n")) {
    const found = /^\s*FAIL\s+(\S+)/.exec(line);
    if (found) files.add(found[1]);
  }
  return [...files];
}

export const NEEDS_BROWSER = /-ui\.e2e\.test\.[cm]?[jt]s$/;
const NOT_RUN = new Set(["skipped", "pending", "todo"]);

export function reportFile(name, root) {
  return isAbsolute(name) && root ? relative(root, name) : name;
}

export function browserSkips(report, root = "") {
  if (!report || !Array.isArray(report.testResults)) return [];
  return report.testResults
    .filter((file) => NEEDS_BROWSER.test(file.name ?? "") && (file.assertionResults ?? []).some((test) => NOT_RUN.has(test.status)))
    .map((file) => reportFile(file.name, root));
}

export function readReport(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

export function vitestCounts(log) {
  const files = /^\s*Test Files\s+(.+)$/m.exec(log)?.[1]?.trim();
  const tests = /^\s*Tests\s+(.+)$/m.exec(log)?.[1]?.trim();
  return files ? { files, tests: tests ?? "" } : null;
}

export function judgeStep(step, code, log, report = null, root = "") {
  if (step.kind === "base") return { ...step, code, failed: code !== 0, failing: code === 0 ? [] : [step.name], skippedNoBrowser: [], note: log.trim() };
  if (step.kind === "check") return { ...step, code, failed: code !== 0, failing: code === 0 ? [] : [step.name], skippedNoBrowser: [], note: "" };
  const files = failingFiles(log);
  const counts = vitestCounts(log);
  const failed = code !== 0 || files.length > 0 || counts === null;
  const failing = files.length ? files : failed ? [`${step.name} (exit ${code}${counts ? "" : ", no test summary"})`] : [];
  return { ...step, code, failed, failing, skippedNoBrowser: browserSkips(report, root), note: counts ? `Test Files ${counts.files}; Tests ${counts.tests}` : "" };
}

export function verdict(results, { noBrowser = false, partial = false } = {}) {
  const failing = [...new Set(results.flatMap((result) => result.failing))];
  const skippedNoBrowser = [...new Set(results.flatMap((result) => result.skippedNoBrowser ?? []))];
  const clean = results.length > 0 && failing.length === 0 && (noBrowser || skippedNoBrowser.length === 0);
  const label = !clean ? "FAIL" : partial ? "PARTIAL" : "PASS";
  return { pass: label === "PASS", label, failing, skippedNoBrowser };
}

export function exitCode(label) {
  return label === "PASS" ? 0 : label === "PARTIAL" ? 3 : 1;
}

export function formatVerdict(results, options = {}) {
  const { label, failing, skippedNoBrowser } = verdict(results, options);
  const lines = results.map((result) => `${result.failed ? "FAIL" : "ok  "} ${result.name} exit ${result.code}${result.note ? `  ${result.note}` : ""}`);
  if (skippedNoBrowser.length) {
    lines.push(`Skipped without a browser: ${skippedNoBrowser.length}${options.noBrowser ? " (allowed by LATERDOG_GATE_NO_BROWSER)" : " (set LATERDOG_GATE_NO_BROWSER=1 only on a machine meant to have none)"}`, ...skippedNoBrowser.map((name) => `  ${name}`));
  }
  const commits = options.commits ? `  head ${options.commits.head}, ${BASE} ${options.commits.base}${options.commits.offline ? " (offline: origin/main not fetched)" : ""}` : "";
  lines.push(`VERDICT: ${label}${commits}${label === "PARTIAL" ? ` (ran only: ${results.filter((result) => result.kind !== "base").map((result) => result.name).join(", ")}; a merge needs the whole gate)` : ""}`);
  if (failing.length) lines.push("Failing:", ...failing.map((name) => `  ${name}`));
  return lines.join("\n");
}

function git(root, ...args) {
  const out = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { code: out.status ?? 1, text: (out.stdout ?? "").trim(), error: (out.stderr ?? "").trim() };
}

export const BASE = "origin/main";

export function baseCheck(root, { offline = false } = {}) {
  const head = git(root, "rev-parse", "--short", "HEAD").text || "unknown";
  const commits = { head, base: "unknown", offline };
  if (!offline) {
    const fetched = git(root, "fetch", "--quiet", "origin", "main");
    if (fetched.code !== 0) return { code: 1, commits, log: `head ${head}; could not fetch origin main (${fetched.error.split("\n")[0] || `exit ${fetched.code}`}); set LATERDOG_GATE_OFFLINE=1 only to judge against the origin/main already here` };
  }
  const base = git(root, "rev-parse", "--verify", "--quiet", "--short", `${BASE}^{commit}`);
  if (base.code !== 0) return { code: 1, commits, log: `head ${head}; ${BASE} is not known here` };
  commits.base = base.text;
  const merged = git(root, "merge-base", "--is-ancestor", BASE, "HEAD").code === 0;
  const changed = (spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout ?? "").split("\n").filter(Boolean);
  const problems = [
    ...(merged ? [] : [`${BASE} ${base.text} is NOT merged in`]),
    ...(changed.length ? [`${changed.length} file(s) differ from the commit or are untracked: ${changed.slice(0, 5).map((line) => line.slice(3)).join(", ")}${changed.length > 5 ? ", ..." : ""}`] : []),
  ];
  return { code: problems.length ? 1 : 0, commits, log: `head ${head}; ${BASE} ${base.text}${offline ? " (offline: not fetched)" : ""}${problems.length ? `; ${problems.join("; ")}` : " is merged in; the tree matches the commit"}` };
}

function runStep(root, step, wrapper, logFile, reportPath) {
  return new Promise((done) => {
    const cwd = step.cwd ? join(root, step.cwd) : root;
    const out = createWriteStream(logFile);
    if (step.needs && !existsSync(join(root, step.needs))) {
      out.end(`${step.needs} is missing: install the dependencies in ${step.cwd} first\n`, () => done(1));
      return;
    }
    const [command, ...args] = [...wrapper, ...step.command, ...(step.kind === "vitest" ? ["--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`] : [])];
    const child = spawn(command, args, { cwd, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.once("error", (error) => out.end(`${error.message}\n`, () => done(127)));
    child.once("close", (code, signal) => out.end(signal ? `stopped by ${signal}\n` : "", () => done(code ?? 1)));
  });
}

async function main() {
  const root = git(process.cwd(), "rev-parse", "--show-toplevel").text || process.cwd();
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24) {
    console.error(`merge gate: Node ${process.versions.node} is too old; later.dog needs Node 24 or newer`);
    process.exit(2);
  }
  const wrapper = wrapperFrom(process.env.LATERDOG_GATE_WRAP);
  const chosen = selectSteps(gateSteps(), process.argv.slice(2));
  if (chosen.error) {
    console.error(`merge gate: ${chosen.error}`);
    process.exit(2);
  }
  const options = { noBrowser: process.env.LATERDOG_GATE_NO_BROWSER === "1", partial: chosen.partial };
  const logs = resolve(process.env.LATERDOG_GATE_LOGS || join(tmpdir(), `laterdog-gate-${Date.now()}`));
  mkdirSync(logs, { recursive: true });
  const results = [];
  const started = Date.now();
  const merged = baseCheck(root, { offline: process.env.LATERDOG_GATE_OFFLINE === "1" });
  options.commits = merged.commits;
  results.push(judgeStep({ name: `${BASE} merged`, kind: "base" }, merged.code, merged.log));
  console.log(`merge gate in ${root}; logs in ${logs}${wrapper.length ? `; each step through ${wrapper.join(" ")}` : ""}`);
  console.log(`${merged.log}`);
  for (const [index, step] of chosen.steps.entries()) {
    const logFile = join(logs, `${String(index + 1).padStart(2, "0")}-${step.name.replace(/[^a-z0-9]+/gi, "-")}.log`);
    const stepStarted = Date.now();
    const reportPath = logFile.replace(/\.log$/, ".json");
    const code = await runStep(root, step, wrapper, logFile, reportPath);
    const result = judgeStep(step, code, readFileSync(logFile, "utf8"), step.kind === "vitest" ? readReport(reportPath) : null, root);
    results.push(result);
    console.log(`${result.failed ? "FAIL" : "ok  "} ${step.name} exit ${code} in ${Math.round((Date.now() - stepStarted) / 1000)}s${result.note ? `  ${result.note}` : ""}`);
  }
  const report = formatVerdict(results, options);
  writeFileSync(join(logs, "verdict.txt"), `${report}\n`);
  console.log(`\n${report}\nwhole gate ${Math.round((Date.now() - started) / 60_000)} min; logs in ${logs}`);
  process.exit(exitCode(verdict(results, options).label));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
