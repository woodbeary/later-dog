import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { browserSkips, failingFiles, formatVerdict, gateSteps, judgeStep, verdict, vitestCounts, wrapperFrom } from "./merge-gate.mjs";

const script = fileURLToPath(new URL("./merge-gate.mjs", import.meta.url));
const passing = " ✓ server/a.test.ts (3 tests) 20ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n";
const failing = " FAIL  server/b.test.ts > b > breaks\nAssertionError\n FAIL  server/b.test.ts > b > breaks again\n FAIL  src/c.test.ts [ src/c.test.ts ]\n\n Test Files  2 failed | 4 passed (6)\n      Tests  2 failed | 9 passed (11)\n";
const shard = { name: "suite 1/8", kind: "vitest", command: [] };

describe("merge gate verdict", () => {
  it("runs typecheck, lint, the desktop app's node tests, eight suite parts and the edge tests, in that order", () => {
    expect(gateSteps().find((step) => step.name === "electron")).toMatchObject({ kind: "check", command: ["pnpm", "test:electron"] });
    expect(gateSteps().map((step) => step.name)).toEqual(["typecheck", "lint", "electron", ...Array.from({ length: 8 }, (_, index) => `suite ${index + 1}/8`), "edge"]);
    expect(gateSteps().at(-1)).toMatchObject({ cwd: "deploy/laterdog/home", command: ["pnpm", "exec", "vitest", "run"] });
  });

  it("names each failing test file once and reads the counts", () => {
    expect(failingFiles(failing)).toEqual(["server/b.test.ts", "src/c.test.ts"]);
    expect(failingFiles(passing)).toEqual([]);
    expect(vitestCounts(failing)).toEqual({ files: "2 failed | 4 passed (6)", tests: "2 failed | 9 passed (11)" });
    expect(vitestCounts("Segmentation fault")).toBeNull();
  });

  it("fails a suite part that exits non-zero, names a failing file, or never printed its summary", () => {
    expect(judgeStep(shard, 0, passing)).toMatchObject({ failed: false, failing: [] });
    expect(judgeStep(shard, 1, failing)).toMatchObject({ failed: true, failing: ["server/b.test.ts", "src/c.test.ts"] });
    expect(judgeStep(shard, 0, failing)).toMatchObject({ failed: true });
    expect(judgeStep(shard, 0, "killed")).toMatchObject({ failed: true, failing: ["suite 1/8 (exit 0, no test summary)"] });
    expect(judgeStep(shard, 137, "killed")).toMatchObject({ failed: true, failing: ["suite 1/8 (exit 137, no test summary)"] });
    expect(judgeStep({ name: "lint", kind: "check", command: [] }, 1, "")).toMatchObject({ failed: true, failing: ["lint"] });
  });

  it("passes only when every step passed and at least one ran", () => {
    expect(verdict([])).toEqual({ pass: false, label: "FAIL", failing: [], skippedNoBrowser: [] });
    expect(verdict([judgeStep(shard, 0, passing)], { partial: true })).toMatchObject({ pass: false, label: "PARTIAL" });
    expect(verdict([judgeStep(shard, 0, passing)])).toEqual({ pass: true, label: "PASS", failing: [], skippedNoBrowser: [] });
    const report = formatVerdict([judgeStep(shard, 0, passing), judgeStep({ ...shard, name: "suite 2/8" }, 1, failing)]);
    expect(report).toContain("VERDICT: FAIL");
    expect(report.split("Failing:\n")[1]).toBe("  server/b.test.ts\n  src/c.test.ts");
  });

  it("fails a run whose interface tests skipped for want of a browser, unless the machine has none on purpose", () => {
    const skipped = `stdout | scripts/testing/thinking-timer-ui.e2e.test.ts\nskipping thinking-timer ui e2e: no agent-browser binary resolves (looked in x)\n\nstdout | scripts/testing/control-laterdog-ui.e2e.test.ts\nskipping control-laterdog ui e2e: no agent-browser binary resolves (looked in x)\n${passing}`;
    expect(browserSkips(skipped)).toEqual(["scripts/testing/thinking-timer-ui.e2e.test.ts", "scripts/testing/control-laterdog-ui.e2e.test.ts"]);
    expect(browserSkips(passing)).toEqual([]);
    const results = [judgeStep(shard, 0, skipped)];
    expect(results[0]).toMatchObject({ failed: false, failing: [] });
    expect(verdict(results)).toMatchObject({ pass: false, skippedNoBrowser: ["scripts/testing/thinking-timer-ui.e2e.test.ts", "scripts/testing/control-laterdog-ui.e2e.test.ts"] });
    expect(formatVerdict(results)).toContain("Skipped without a browser: 2");
    expect(formatVerdict(results)).toContain("  scripts/testing/thinking-timer-ui.e2e.test.ts\n");
    expect(formatVerdict(results)).toContain("VERDICT: FAIL");
    expect(verdict(results, { noBrowser: true }).pass).toBe(true);
    expect(formatVerdict(results, { noBrowser: true })).toContain("VERDICT: PASS");
  });

  it("splits the wrapper command from its environment variable", () => {
    expect(wrapperFrom(undefined)).toEqual([]);
    expect(wrapperFrom("  queue.sh  --wait ")).toEqual(["queue.sh", "--wait"]);
  });
});

describe("merge gate exit code", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  const gate = (args: string[], { failOn = "", env = {}, edgeDeps = true }: { failOn?: string; env?: Record<string, string>; edgeDeps?: boolean } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "laterdog-gate-test-"));
    dirs.push(dir);
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const git = (...gitArgs: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...gitArgs], { cwd: repo });
    git("init", "-q");
    writeFileSync(join(repo, ".gitignore"), "node_modules\n");
    git("add", ".gitignore");
    git("commit", "-q", "-m", "start");
    if (edgeDeps) mkdirSync(join(repo, "deploy/laterdog/home/node_modules"), { recursive: true });
    const fake = join(dir, "fake.mjs");
    writeFileSync(fake, `const words = process.argv.slice(2).join(" ");
if (${JSON.stringify(failOn)} && words.includes(${JSON.stringify(failOn)})) { console.log(${JSON.stringify(failing)}); process.exit(1); }
if (words.includes("--shard=2/8") && process.env.FAKE_NO_BROWSER) console.log("stdout | scripts/testing/thinking-timer-ui.e2e.test.ts\\nskipping thinking-timer ui e2e: no agent-browser binary resolves");
console.log(words.includes("vitest") ? ${JSON.stringify(passing)} : "checked");
`);
    return spawnSync(process.execPath, [script, ...args], {
      cwd: repo, encoding: "utf8",
      env: { ...process.env, LATERDOG_GATE_NO_BROWSER: "", LATERDOG_GATE_WRAP: `${process.execPath} ${fake}`, LATERDOG_GATE_BASE: "HEAD", LATERDOG_GATE_LOGS: join(dir, "logs"), ...env },
    });
  };

  it("exits 0 with a PASS verdict only when the whole gate ran and passed", () => {
    const run = gate([]);
    expect(run.stdout).toContain("VERDICT: PASS");
    expect(run.status).toBe(0);
  });

  it("calls any --only run PARTIAL and exits 3, naming what ran", () => {
    const run = gate(["--only", "typecheck,lint"]);
    expect(run.stdout).toContain("VERDICT: PARTIAL (ran only: typecheck, lint; a merge needs the whole gate)");
    expect(run.stdout).not.toContain("VERDICT: PASS");
    expect(run.status).toBe(3);
  });

  it("refuses an unknown or missing step name before running anything", () => {
    for (const args of [["--only", "nosuchstep"], ["--only"], ["--only", "--x"], ["--only", "lint,nosuchstep"], ["--only", ","]]) {
      const run = gate(args);
      expect(run.stdout, args.join(" ")).not.toContain("VERDICT");
      expect(run.stderr, args.join(" ")).toContain("merge gate:");
      expect(run.status, args.join(" ")).toBe(2);
    }
  });

  it("exits 1 and lists the failing files when one suite part fails", () => {
    const run = gate([], { failOn: "--shard=3/8" });
    expect(run.stdout).toContain("VERDICT: FAIL");
    expect(run.stdout).toContain("Failing:\n  server/b.test.ts\n  src/c.test.ts");
    expect(run.status).toBe(1);
  });

  it("exits 1 when an interface test skipped for want of a browser, and 0 when the machine has none on purpose", () => {
    const skipped = gate([], { env: { FAKE_NO_BROWSER: "1" } });
    expect(skipped.stdout).toMatch(/Skipped without a browser: 1 .*\n {2}scripts\/testing\/thinking-timer-ui\.e2e\.test\.ts\n/);
    expect(skipped.status).toBe(1);
    const allowed = gate([], { env: { FAKE_NO_BROWSER: "1", LATERDOG_GATE_NO_BROWSER: "1" } });
    expect(allowed.stdout).toContain("VERDICT: PASS");
    expect(allowed.status).toBe(0);
  });

  it("fails the edge step when its dependencies are not installed", () => {
    const run = gate([], { edgeDeps: false });
    expect(run.stdout).toContain("FAIL edge exit 1");
    expect(run.status).toBe(1);
  });

  it("fails when the base branch is not merged in", () => {
    const run = gate([], { env: { LATERDOG_GATE_BASE: "no-such-branch" } });
    expect(run.stdout).toContain("FAIL no-such-branch merged exit 1");
    expect(run.status).toBe(1);
  });
});
