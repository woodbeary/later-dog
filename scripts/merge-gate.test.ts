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
  it("runs every test set in the repository, in this order", () => {
    expect(gateSteps().map((step) => step.name)).toEqual(["typecheck", "lint", "electron", "broker", "packaged-server", ...Array.from({ length: 8 }, (_, index) => `suite ${index + 1}/8`), "edge", "control-plane", "computers"]);
    const step = (name: string) => gateSteps().find((candidate) => candidate.name === name);
    expect(step("electron")).toMatchObject({ kind: "check", command: ["pnpm", "test:electron"] });
    expect(step("broker")).toMatchObject({ kind: "vitest", command: ["pnpm", "exec", "vitest", "run", "--config", "cloudflare/composio-broker/vitest.config.ts"] });
    expect(step("packaged-server")).toMatchObject({ kind: "check", command: ["pnpm", "test:packaged-server"] });
    for (const [name, cwd] of [["edge", "deploy/laterdog/home"], ["control-plane", "cloudflare/control-plane"], ["computers", "deploy/laterdog/computers"]]) {
      expect(step(name)).toMatchObject({ kind: "vitest", cwd, needs: `${cwd}/node_modules`, command: ["pnpm", "exec", "vitest", "run"] });
    }
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts.test).toBe("vitest run && pnpm broker:test && pnpm test:electron && pnpm test:packaged-server");
  });

  it("names each failing test file once and reads the counts", () => {
    expect(failingFiles(failing)).toEqual(["server/b.test.ts", "src/c.test.ts"]);
    expect(failingFiles(passing)).toEqual([]);
    expect(vitestCounts(failing)).toEqual({ files: "2 failed | 4 passed (6)", tests: "2 failed | 9 passed (11)" });
    expect(vitestCounts("Segmentation fault")).toBeNull();
  });

  it("fails a suite part on its report, its unhandled errors or its summary, even when a wrapper swallowed the exit code", () => {
    const clean = recorded("stray.json", "/repo");
    const strayLog = readFileSync(new URL("./testing/merge-gate-fixtures/stray.log", import.meta.url), "utf8");
    expect(judgeStep(shard, 0, passing, clean, "/repo")).toMatchObject({ failed: false, failing: [] });
    expect(judgeStep(shard, 0, strayLog, clean, "/repo")).toMatchObject({ failed: true, failing: ["suite 1/8 (1 unhandled error)"] });
    expect(judgeStep(shard, 0, passing, recorded("fails.json", "/repo"), "/repo")).toMatchObject({ failed: true, failing: ["scripts/testing/fails.test.mjs"] });
    expect(judgeStep(shard, 0, passing, null)).toMatchObject({ failed: true, failing: ["suite 1/8 (no JSON report)"] });
    expect(judgeStep(shard, 0, passing, { ...clean, numTotalTests: 0, testResults: [] })).toMatchObject({ failed: true, failing: ["suite 1/8 (no tests ran)"] });
    expect(judgeStep(shard, 0, " Test Files  1 failed (1)\n      Tests  1 failed (1)\n", clean, "/repo")).toMatchObject({ failed: true, failing: ["suite 1/8 (its summary counts failed files)"] });
    expect(judgeStep(shard, 1, failing, clean, "/repo")).toMatchObject({ failed: true, failing: ["server/b.test.ts", "src/c.test.ts"] });
    expect(judgeStep(shard, 137, "killed", clean, "/repo")).toMatchObject({ failed: true, failing: ["suite 1/8 (exit 137)"] });
  });

  it("fails typecheck, lint and the node tests on what they print, not only on their exit code", () => {
    const step = (name: string) => gateSteps().find((candidate) => candidate.name === name)!;
    expect(judgeStep(step("typecheck"), 0, "")).toMatchObject({ failed: false });
    expect(judgeStep(step("typecheck"), 0, "src/a.ts(1,1): error TS2322: no")).toMatchObject({ failed: true, failing: ["typecheck (printed error TS2322)"] });
    expect(judgeStep(step("lint"), 0, "Found 0 warnings and 0 errors.")).toMatchObject({ failed: false });
    expect(judgeStep(step("lint"), 0, "Found 0 warnings and 2 errors.")).toMatchObject({ failed: true });
    expect(judgeStep(step("lint"), 0, "Found 3 warnings and 0 errors.")).toMatchObject({ failed: true });
    expect(judgeStep(step("electron"), 0, "ℹ tests 945\nℹ pass 942\nℹ fail 0\n")).toMatchObject({ failed: false });
    expect(judgeStep(step("electron"), 0, "ℹ tests 945\nℹ fail 1\n")).toMatchObject({ failed: true });
    expect(judgeStep(step("electron"), 0, "ℹ tests 0\nℹ fail 0\n")).toMatchObject({ failed: true });
    expect(judgeStep(step("lint"), 1, "")).toMatchObject({ failed: true, failing: ["lint"] });
  });

  it("passes only when every step passed and at least one ran", () => {
    const clean = recorded("stray.json", "/repo");
    expect(verdict([])).toEqual({ pass: false, label: "FAIL", failing: [], skippedNoBrowser: [], notRun: [] });
    expect(verdict([judgeStep(shard, 0, passing, clean)], { partial: true })).toMatchObject({ pass: false, label: "PARTIAL" });
    expect(verdict([judgeStep(shard, 0, passing, clean)])).toEqual({ pass: true, label: "PASS", failing: [], skippedNoBrowser: [], notRun: [] });
    const report = formatVerdict([judgeStep(shard, 0, passing, clean), judgeStep({ ...shard, name: "suite 2/8" }, 1, failing, clean)]);
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

  interface Setup { failOn?: string; env?: Record<string, string>; deps?: string[]; before?: (repo: string, git: (cwd: string, ...args: string[]) => void, origin: string) => void }
  const gate = (args: string[], { failOn = "", env = {}, deps = ["deploy/laterdog/home", "cloudflare/control-plane", "deploy/laterdog/computers"], before }: Setup = {}) => {
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
    for (const dep of deps) mkdirSync(join(repo, dep, "node_modules"), { recursive: true });
    before?.(repo, git, origin);
    const fake = join(dir, "fake.mjs");
    writeFileSync(fake, `const require = (await import("node:module")).createRequire(import.meta.url);
const words = process.argv.slice(2).join(" ");
if (${JSON.stringify(failOn)} && words.includes(${JSON.stringify(failOn)})) { console.log(${JSON.stringify(failing)}); process.exit(1); }
const out = process.argv.find((word) => word.startsWith("--outputFile.json="))?.slice("--outputFile.json=".length);
const skip = words.includes("--shard=2/8") && process.env.FAKE_NO_BROWSER;
if (out) require("node:fs").writeFileSync(out, (skip ? ${JSON.stringify(JSON.stringify(recorded("skip.json", "<cwd>")))} : ${JSON.stringify(JSON.stringify(recorded("stray.json", "<cwd>")))}).replaceAll("<cwd>", process.cwd()));
if (words.includes("typecheck") && process.env.FAKE_TYPE_ERROR) console.log("src/a.ts(1,1): error TS2322: no");
console.log(words.includes("vitest") ? ${JSON.stringify(passing)} : words.includes("test:electron") ? "ℹ tests 3\\nℹ fail 0" : words.includes("test:packaged-server") ? "packaged backup worker exported an encrypted archive ✓" : "checked");
`);
    return spawnSync(process.execPath, [script, ...args], {
      cwd: repo, encoding: "utf8",
      env: { ...process.env, LATERDOG_GATE_NO_BROWSER: "", LATERDOG_GATE_WRAP: `${process.execPath} ${fake}`, LATERDOG_GATE_OFFLINE: "", LATERDOG_GATE_UNAVAILABLE: "", LATERDOG_GATE_LOGS: join(dir, "logs"), ...env },
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

  it("fails a typecheck that printed errors even when the wrapper reports success", () => {
    const run = gate(["--only", "typecheck"], { env: { FAKE_TYPE_ERROR: "1" } });
    expect(run.stdout).toContain("FAIL typecheck exit 0");
    expect(run.stdout).toContain("VERDICT: FAIL");
    expect(run.status).toBe(1);
  });

  it("fails a test set whose dependencies are missing, unless it is named as unavailable here, and then lists it on the verdict line", () => {
    const missing = gate([], { deps: ["deploy/laterdog/home", "cloudflare/control-plane"] });
    expect(missing.stdout).toContain("FAIL computers  deploy/laterdog/computers/node_modules is missing");
    expect(missing.stdout).toContain("Failing:\n  computers (deploy/laterdog/computers/node_modules is missing)");
    expect(missing.status).toBe(1);
    const named = gate([], { deps: ["deploy/laterdog/home", "cloudflare/control-plane"], env: { LATERDOG_GATE_UNAVAILABLE: "computers" } });
    expect(named.stdout).toContain("skip computers  not run here");
    expect(named.stdout).toMatch(/VERDICT: PASS {2}head \w+, origin\/main \w+ \(not run here on purpose: computers\)\n/);
    expect(named.status).toBe(0);
    const present = gate([], { env: { LATERDOG_GATE_UNAVAILABLE: "computers" } });
    expect(present.stdout).toContain("ok   computers exit 0");
    expect(present.stdout).not.toContain("not run here on purpose");
    for (const name of ["suite 1/8", "nosuchstep"]) {
      const refused = gate([], { env: { LATERDOG_GATE_UNAVAILABLE: name } });
      expect(refused.stderr).toContain("LATERDOG_GATE_UNAVAILABLE names");
      expect(refused.status).toBe(2);
    }
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
