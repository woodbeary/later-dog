import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { NEEDS_BROWSER, browserSkips, failingFiles, formatVerdict, gateSteps, judgeStep, verdict, vitestCounts, wrapperFrom } from "./merge-gate.mjs";

const script = fileURLToPath(new URL("./merge-gate.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const HOW_RECORDED = "pnpm exec vitest run --reporter=default --reporter=json --outputFile.json=<file> on a scratch folder of four files: one passing test, one failing test, one test that throws after it finishes, and screen-ui.e2e.test.mjs whose only test is skipped unless LATERDOG_UI_E2E=1, as the interface tests are; the folder's absolute path was then replaced by <root>/scripts/testing";
const recorded = (name: string, root: string) => JSON.parse(readFileSync(new URL(`./testing/merge-gate-fixtures/${name}`, import.meta.url), "utf8").replaceAll("<root>", root));
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

  it(`fails a run whose interface tests skipped, unless the machine has no browser on purpose, judged from a vitest report recorded with ${HOW_RECORDED}`, () => {
    const report = recorded("skip.json", "/repo");
    expect(browserSkips(report, "/repo")).toEqual(["scripts/testing/screen-ui.e2e.test.mjs"]);
    expect(browserSkips(recorded("fails.json", "/repo"), "/repo")).toEqual([]);
    expect(browserSkips(null)).toEqual([]);
    const results = [judgeStep(shard, 0, passing, report, "/repo")];
    expect(results[0]).toMatchObject({ failed: false, failing: [] });
    expect(verdict(results)).toMatchObject({ pass: false, label: "FAIL", skippedNoBrowser: ["scripts/testing/screen-ui.e2e.test.mjs"] });
    expect(formatVerdict(results)).toContain("Skipped without a browser: 1");
    expect(formatVerdict(results)).toContain("\n  scripts/testing/screen-ui.e2e.test.mjs\n");
    expect(verdict(results, { noBrowser: true }).pass).toBe(true);
  });

  it("treats every interface test as needing the browser by its name, and every test that waits for the browser is named so", () => {
    const files = execFileSync("git", ["ls-files", "*.test.ts", "*.test.mjs"], { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);
    const waits = files.filter((file) => file !== "scripts/merge-gate.test.ts" && readFileSync(join(repoRoot, file), "utf8").includes("LATERDOG_UI_E2E"));
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.filter((file) => !NEEDS_BROWSER.test(file))).toEqual([]);
    expect(files.filter((file) => NEEDS_BROWSER.test(file) && !waits.includes(file))).toEqual([]);
  });

  it("splits the wrapper command from its environment variable", () => {
    expect(wrapperFrom(undefined)).toEqual([]);
    expect(wrapperFrom("  queue.sh  --wait ")).toEqual(["queue.sh", "--wait"]);
  });
});

describe("merge gate exit code", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  interface Setup { failOn?: string; env?: Record<string, string>; edgeDeps?: boolean; before?: (repo: string, git: (cwd: string, ...args: string[]) => void, origin: string) => void }
  const gate = (args: string[], { failOn = "", env = {}, edgeDeps = true, before }: Setup = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "laterdog-gate-test-"));
    dirs.push(dir);
    const origin = join(dir, "origin.git");
    const repo = join(dir, "repo");
    const git = (cwd: string, ...gitArgs: string[]) => { spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...gitArgs], { cwd }); };
    git(dir, "init", "-q", "--bare", "-b", "main", origin);
    git(dir, "clone", "-q", origin, repo);
    writeFileSync(join(repo, ".gitignore"), "node_modules\n");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-q", "-m", "start");
    git(repo, "push", "-q", "origin", "HEAD:main");
    if (edgeDeps) mkdirSync(join(repo, "deploy/laterdog/home/node_modules"), { recursive: true });
    before?.(repo, git, origin);
    const fake = join(dir, "fake.mjs");
    writeFileSync(fake, `const require = (await import("node:module")).createRequire(import.meta.url);
const words = process.argv.slice(2).join(" ");
if (${JSON.stringify(failOn)} && words.includes(${JSON.stringify(failOn)})) { console.log(${JSON.stringify(failing)}); process.exit(1); }
const out = process.argv.find((word) => word.startsWith("--outputFile.json="))?.slice("--outputFile.json=".length);
const skip = words.includes("--shard=2/8") && process.env.FAKE_NO_BROWSER;
if (out) require("node:fs").writeFileSync(out, skip ? ${JSON.stringify(JSON.stringify(recorded("skip.json", "<cwd>")))}.replaceAll("<cwd>", process.cwd()) : ${JSON.stringify(JSON.stringify(recorded("fails.json", "<cwd>")))}.replaceAll("<cwd>", process.cwd()).replace(/"status":"failed"/g, '"status":"passed"'));
console.log(words.includes("vitest") ? ${JSON.stringify(passing)} : "checked");
`);
    return spawnSync(process.execPath, [script, ...args], {
      cwd: repo, encoding: "utf8",
      env: { ...process.env, LATERDOG_GATE_NO_BROWSER: "", LATERDOG_GATE_WRAP: `${process.execPath} ${fake}`, LATERDOG_GATE_OFFLINE: "", LATERDOG_GATE_LOGS: join(dir, "logs"), ...env },
    });
  };

  it("exits 0 with a PASS verdict only when the whole gate ran and passed", () => {
    const run = gate([]);
    expect(run.stdout).toContain("VERDICT: PASS");
    expect(run.status).toBe(0);
  });

  it("calls any --only run PARTIAL and exits 3, naming what ran", () => {
    const run = gate(["--only", "typecheck,lint"]);
    expect(run.stdout).toMatch(/VERDICT: PARTIAL {2}head \w+, origin\/main \w+ \(ran only: typecheck, lint; a merge needs the whole gate\)/);
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
    expect(skipped.stdout).toMatch(/Skipped without a browser: 1 .*\n {2}scripts\/testing\/screen-ui\.e2e\.test\.mjs\n/);
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

  it("fetches origin main first and fails when it moved past the branch", () => {
    const run = gate([], { before: (repo, git, origin) => {
      const other = join(repo, "..", "other");
      git(join(repo, ".."), "clone", "-q", origin, other);
      writeFileSync(join(other, "moved.txt"), "main moved\n");
      git(other, "add", ".");
      git(other, "commit", "-q", "-m", "main moved");
      git(other, "push", "-q", "origin", "HEAD:main");
    } });
    expect(run.stdout).toMatch(/FAIL origin\/main merged exit 1 .*is NOT merged in/);
    expect(run.status).toBe(1);
  });

  it("fails when the fetch fails, and says so when an offline run is allowed", () => {
    const breakOrigin: Setup["before"] = (repo, git) => git(repo, "remote", "set-url", "origin", join(repo, "..", "gone.git"));
    const failed = gate([], { before: breakOrigin });
    expect(failed.stdout).toContain("could not fetch origin main");
    expect(failed.status).toBe(1);
    const offline = gate([], { before: breakOrigin, env: { LATERDOG_GATE_OFFLINE: "1" } });
    expect(offline.stdout).toMatch(/VERDICT: PASS {2}head [0-9a-f]+, origin\/main [0-9a-f]+ \(offline: origin\/main not fetched\)/);
    expect(offline.status).toBe(0);
  });

  it("fails when a tracked file differs from the commit or an untracked file is present, and ignores ignored ones", () => {
    const dirty = gate([], { before: (repo) => writeFileSync(join(repo, ".gitignore"), "changed\n") });
    expect(dirty.stdout).toContain("differ from the commit or are untracked: .gitignore");
    expect(dirty.status).toBe(1);
    const untracked = gate([], { before: (repo) => writeFileSync(join(repo, "extra.test.ts"), "") });
    expect(untracked.stdout).toContain("untracked: extra.test.ts");
    expect(untracked.status).toBe(1);
  });

  it("prints the head and origin/main commits on the verdict line", () => {
    expect(gate([]).stdout).toMatch(/VERDICT: PASS {2}head [0-9a-f]{7,}, origin\/main [0-9a-f]{7,}\n/);
  });
});
