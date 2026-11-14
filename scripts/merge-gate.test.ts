import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { failingFiles, formatVerdict, gateSteps, judgeStep, verdict, vitestCounts, wrapperFrom } from "./merge-gate.mjs";

const script = fileURLToPath(new URL("./merge-gate.mjs", import.meta.url));
const passing = " ✓ server/a.test.ts (3 tests) 20ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n";
const failing = " FAIL  server/b.test.ts > b > breaks\nAssertionError\n FAIL  server/b.test.ts > b > breaks again\n FAIL  src/c.test.ts [ src/c.test.ts ]\n\n Test Files  2 failed | 4 passed (6)\n      Tests  2 failed | 9 passed (11)\n";
const shard = { name: "suite 1/8", kind: "vitest", command: [] };

describe("merge gate verdict", () => {
  it("runs typecheck, lint, eight suite parts and the edge tests, in that order", () => {
    expect(gateSteps().map((step) => step.name)).toEqual(["typecheck", "lint", ...Array.from({ length: 8 }, (_, index) => `suite ${index + 1}/8`), "edge"]);
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
    expect(verdict([])).toEqual({ pass: false, failing: [] });
    expect(verdict([judgeStep(shard, 0, passing)])).toEqual({ pass: true, failing: [] });
    const report = formatVerdict([judgeStep(shard, 0, passing), judgeStep({ ...shard, name: "suite 2/8" }, 1, failing)]);
    expect(report).toContain("VERDICT: FAIL");
    expect(report.split("Failing:\n")[1]).toBe("  server/b.test.ts\n  src/c.test.ts");
  });

  it("splits the wrapper command from its environment variable", () => {
    expect(wrapperFrom(undefined)).toEqual([]);
    expect(wrapperFrom("  queue.sh  --wait ")).toEqual(["queue.sh", "--wait"]);
  });
});

describe("merge gate exit code", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  const gate = (args: string[], fakeFailsOn = "", base = "HEAD") => {
    const dir = mkdtempSync(join(tmpdir(), "laterdog-gate-test-"));
    dirs.push(dir);
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const git = (...gitArgs: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...gitArgs], { cwd: repo });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "start");
    const fake = join(dir, "fake.mjs");
    writeFileSync(fake, `const words = process.argv.slice(2).join(" ");
if (${JSON.stringify(fakeFailsOn)} && words.includes(${JSON.stringify(fakeFailsOn)})) { console.log(${JSON.stringify(failing)}); process.exit(1); }
console.log(words.includes("vitest") ? ${JSON.stringify(passing)} : "checked");
`);
    return spawnSync(process.execPath, [script, ...args], {
      cwd: repo, encoding: "utf8",
      env: { ...process.env, LATERDOG_GATE_WRAP: `${process.execPath} ${fake}`, LATERDOG_GATE_BASE: base, LATERDOG_GATE_LOGS: join(dir, "logs") },
    });
  };

  it("exits 0 with a PASS verdict when every step passes", () => {
    const run = gate(["--only", "typecheck,lint,suite"]);
    expect(run.stdout).toContain("VERDICT: PASS");
    expect(run.status).toBe(0);
  });

  it("exits 1 and lists the failing files when one suite part fails", () => {
    const run = gate(["--only", "typecheck,suite"], "--shard=3/8");
    expect(run.stdout).toContain("VERDICT: FAIL");
    expect(run.stdout).toContain("Failing:\n  server/b.test.ts\n  src/c.test.ts");
    expect(run.status).toBe(1);
  });

  it("fails the edge step when its dependencies are not installed", () => {
    const run = gate(["--only", "edge"]);
    expect(run.stdout).toContain("FAIL edge exit 1");
    expect(run.status).toBe(1);
  });

  it("fails when the base branch is not merged in", () => {
    const run = gate(["--only", "lint"], "", "no-such-branch");
    expect(run.stdout).toContain("FAIL no-such-branch merged exit 1");
    expect(run.status).toBe(1);
  });
});
