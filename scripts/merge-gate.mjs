import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

export const NO_BROWSER = "no agent-browser binary resolves";

export function browserSkips(log) {
  const files = new Set();
  let current = "";
  for (const line of log.split("\n")) {
    const source = /^\s*std(?:out|err) \| (\S+)/.exec(line);
    if (source) current = source[1];
    if (line.includes(NO_BROWSER)) files.add(current || line.trim());
  }
  return [...files];
}

export function vitestCounts(log) {
  const files = /^\s*Test Files\s+(.+)$/m.exec(log)?.[1]?.trim();
  const tests = /^\s*Tests\s+(.+)$/m.exec(log)?.[1]?.trim();
  return files ? { files, tests: tests ?? "" } : null;
}

export function judgeStep(step, code, log) {
  if (step.kind === "base") return { ...step, code, failed: code !== 0, failing: code === 0 ? [] : [step.name], skippedNoBrowser: [], note: log.trim() };
  if (step.kind === "check") return { ...step, code, failed: code !== 0, failing: code === 0 ? [] : [step.name], skippedNoBrowser: [], note: "" };
  const files = failingFiles(log);
  const counts = vitestCounts(log);
  const failed = code !== 0 || files.length > 0 || counts === null;
  const failing = files.length ? files : failed ? [`${step.name} (exit ${code}${counts ? "" : ", no test summary"})`] : [];
  return { ...step, code, failed, failing, skippedNoBrowser: browserSkips(log), note: counts ? `Test Files ${counts.files}; Tests ${counts.tests}` : "" };
}

export function verdict(results, { noBrowser = false } = {}) {
  const failing = [...new Set(results.flatMap((result) => result.failing))];
  const skippedNoBrowser = [...new Set(results.flatMap((result) => result.skippedNoBrowser ?? []))];
  const pass = results.length > 0 && failing.length === 0 && (noBrowser || skippedNoBrowser.length === 0);
  return { pass, failing, skippedNoBrowser };
}

export function formatVerdict(results, options = {}) {
  const { pass, failing, skippedNoBrowser } = verdict(results, options);
  const lines = results.map((result) => `${result.failed ? "FAIL" : "ok  "} ${result.name} exit ${result.code}${result.note ? `  ${result.note}` : ""}`);
  if (skippedNoBrowser.length) {
    lines.push(`Skipped without a browser: ${skippedNoBrowser.length}${options.noBrowser ? " (allowed by LATERDOG_GATE_NO_BROWSER)" : " (set LATERDOG_GATE_NO_BROWSER=1 only on a machine meant to have none)"}`, ...skippedNoBrowser.map((name) => `  ${name}`));
  }
  lines.push(`VERDICT: ${pass ? "PASS" : "FAIL"}`);
  if (failing.length) lines.push("Failing:", ...failing.map((name) => `  ${name}`));
  return lines.join("\n");
}

function git(root, ...args) {
  const out = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { code: out.status ?? 1, text: (out.stdout ?? "").trim() };
}

export function baseCheck(root, base) {
  const head = git(root, "rev-parse", "--short", "HEAD").text || "unknown";
  const baseSha = git(root, "rev-parse", "--verify", "--quiet", "--short", `${base}^{commit}`);
  if (baseSha.code !== 0) return { code: 1, log: `head ${head}; ${base} is not known here, fetch it first` };
  const merged = git(root, "merge-base", "--is-ancestor", base, "HEAD").code === 0;
  const changed = git(root, "status", "--porcelain", "--untracked-files=no").text;
  const tree = changed ? "; tracked files differ from the commit" : "";
  return { code: merged ? 0 : 1, log: `head ${head}; ${base} ${baseSha.text} ${merged ? "is merged in" : "is NOT merged in"}${tree}` };
}

function runStep(root, step, wrapper, logFile) {
  return new Promise((done) => {
    const cwd = step.cwd ? join(root, step.cwd) : root;
    const out = createWriteStream(logFile);
    if (step.needs && !existsSync(join(root, step.needs))) {
      out.end(`${step.needs} is missing: install the dependencies in ${step.cwd} first\n`, () => done(1));
      return;
    }
    const [command, ...args] = [...wrapper, ...step.command];
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
  const base = process.env.LATERDOG_GATE_BASE || "origin/main";
  const options = { noBrowser: process.env.LATERDOG_GATE_NO_BROWSER === "1" };
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1]?.split(",") ?? [] : null;
  const logs = resolve(process.env.LATERDOG_GATE_LOGS || join(tmpdir(), `laterdog-gate-${Date.now()}`));
  mkdirSync(logs, { recursive: true });
  const results = [];
  const started = Date.now();
  const merged = baseCheck(root, base);
  results.push(judgeStep({ name: `${base} merged`, kind: "base" }, merged.code, merged.log));
  console.log(`merge gate in ${root}; logs in ${logs}${wrapper.length ? `; each step through ${wrapper.join(" ")}` : ""}`);
  console.log(`${merged.log}`);
  const steps = gateSteps().filter((step) => !only || only.some((name) => step.name.startsWith(name)));
  for (const [index, step] of steps.entries()) {
    const logFile = join(logs, `${String(index + 1).padStart(2, "0")}-${step.name.replace(/[^a-z0-9]+/gi, "-")}.log`);
    const stepStarted = Date.now();
    const code = await runStep(root, step, wrapper, logFile);
    const result = judgeStep(step, code, readFileSync(logFile, "utf8"));
    results.push(result);
    console.log(`${result.failed ? "FAIL" : "ok  "} ${step.name} exit ${code} in ${Math.round((Date.now() - stepStarted) / 1000)}s${result.note ? `  ${result.note}` : ""}`);
  }
  const report = formatVerdict(results, options);
  writeFileSync(join(logs, "verdict.txt"), `${report}\n`);
  console.log(`\n${report}\nwhole gate ${Math.round((Date.now() - started) / 60_000)} min; logs in ${logs}`);
  process.exit(verdict(results, options).pass ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
