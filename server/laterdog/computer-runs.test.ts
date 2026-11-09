import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { bringBackList, changesSince, ComputerRuns, parts, type RunBox, setupKey, stampFolder } from "./computer-runs.ts";

const ENVIRONMENTS_MODULE = "../../deploy/laterdog/computers/src/environments.ts";
const environments = await import(ENVIRONMENTS_MODULE);

function localBox(home: string) {
  const commands: string[] = [];
  const box: RunBox = {
    async exec(command) {
      commands.push(command);
      const out = spawnSync("bash", ["-c", command], { cwd: home, env: { ...process.env, HOME: home }, encoding: "utf8" });
      return { exitCode: out.status, stdout: out.stdout, stderr: out.stderr };
    },
    async write(path, bytes) {
      mkdirSync(dirname(join(home, path)), { recursive: true });
      writeFileSync(join(home, path), bytes);
    },
    async read(path) { return readFileSync(join(home, path)); },
  };
  return { box, commands };
}

function project() {
  const root = mkdtempSync(join(tmpdir(), "computer-runs-"));
  const folder = join(root, "site");
  mkdirSync(join(folder, "src"), { recursive: true });
  mkdirSync(join(folder, "node_modules/react"), { recursive: true });
  writeFileSync(join(folder, "package.json"), "{}");
  writeFileSync(join(folder, "src/page.ts"), "export const page = 1;\n");
  writeFileSync(join(folder, "node_modules/react/index.js"), "x".repeat(1000));
  const old = new Date(Date.now() - 60_000);
  for (const path of ["package.json", "src/page.ts"]) utimesSync(join(folder, path), old, old);
  return { root, folder, computer: join(root, "computer"), state: join(root, "state") };
}

const fast = { sleep: async () => undefined };

describe("a heavy command on the dog's own computer", () => {
  it("sends the folder without build output, runs the command there and brings back only what it made", async () => {
    const { folder, computer, state } = project();
    mkdirSync(computer);
    const { box } = localBox(computer);
    const runs = new ComputerRuns(state, fast);
    const outcome = await runs.run(box, { botId: "dog", folder, command: "mkdir -p dist report && echo built > dist/app.js && echo 'all 12 tests passed' | tee report/result.txt && echo changed > src/page.ts" });
    expect(outcome.state).toBe("finished");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toContain("all 12 tests passed");
    expect(outcome.sentFiles).toBe(2);
    expect(outcome.broughtBack.sort()).toEqual(["report/result.txt", "src/page.ts"]);
    expect(readFileSync(join(folder, "src/page.ts"), "utf8")).toBe("changed\n");
    expect(readFileSync(join(folder, "report/result.txt"), "utf8")).toBe("all 12 tests passed\n");
    expect(existsSync(join(folder, "dist"))).toBe(false);
  });

  it("sends only what changed the next time, removes deleted files there, and reports a failing command", async () => {
    const { folder, computer, state } = project();
    mkdirSync(computer);
    const { box } = localBox(computer);
    const runs = new ComputerRuns(state, fast);
    await runs.run(box, { botId: "dog", folder, command: "true" });
    writeFileSync(join(folder, "src/new.ts"), "export {};\n");
    spawnSync("rm", [join(folder, "package.json")]);
    const outcome = await runs.run(box, { botId: "dog", folder, subdir: "src", command: "ls; ls .. ; exit 3" });
    expect(outcome.sentFiles).toBe(1);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.output).toContain("new.ts");
    expect(outcome.output).not.toContain("package.json");
  });

  it("starts a new session's copy of a project from the packages an earlier copy installed", async () => {
    const { root, folder, computer, state } = project();
    mkdirSync(computer);
    writeFileSync(join(folder, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const copy = join(root, "next-session", "site");
    mkdirSync(dirname(copy), { recursive: true });
    spawnSync("cp", ["-R", folder, copy]);
    const other = join(root, "other", "site");
    mkdirSync(dirname(other), { recursive: true });
    spawnSync("cp", ["-R", folder, other]);
    writeFileSync(join(other, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nchanged: true\n");
    const { box } = localBox(computer);
    const runs = new ComputerRuns(state, fast);
    const install = "test -d node_modules/left-pad || (mkdir -p node_modules/left-pad && echo installed > node_modules/left-pad/index.js && echo INSTALLED)";

    const first = await runs.run(box, { botId: "dog", folder, command: install });
    expect(first.output).toContain("INSTALLED");
    expect(first.note ?? "").not.toContain("Reused");

    const failed = await runs.run(box, { botId: "dog", folder: other, command: "mkdir -p node_modules/broken; exit 1" });
    expect(failed.exitCode).toBe(1);

    const second = await runs.run(box, { botId: "dog", folder: copy, command: install });
    expect(second.exitCode).toBe(0);
    expect(second.output).not.toContain("INSTALLED");
    expect(second.note).toContain("Reused the packages");
    expect(existsSync(join(copy, "node_modules/left-pad"))).toBe(false);

    const unmatched = await runs.run(box, { botId: "dog", folder: other, command: install });
    expect(unmatched.output).toContain("INSTALLED");
    expect(unmatched.note ?? "").not.toContain("Reused");
  });

  it("keeps the home's copy of a file someone changed here while the command ran", async () => {
    const { folder, computer, state } = project();
    mkdirSync(computer);
    const { box } = localBox(computer);
    const runs = new ComputerRuns(state, fast);
    const started = await runs.start(box, { botId: "dog", folder, command: "sleep 1; echo theirs > src/page.ts" });
    writeFileSync(join(folder, "src/page.ts"), "mine\n");
    const outcome = await runs.finish(box, started);
    expect(outcome.broughtBack).toEqual([]);
    expect(outcome.note).toContain("src/page.ts");
    expect(readFileSync(join(folder, "src/page.ts"), "utf8")).toBe("mine\n");
  });

  it("hands back a run id while the command is still going, and finishes it on the next call", async () => {
    const { folder, computer, state } = project();
    mkdirSync(computer);
    const { box } = localBox(computer);
    let clock = 0;
    const runs = new ComputerRuns(state, { now: () => clock, sleep: async () => { clock += 10 * 60_000; } });
    const started = await runs.start(box, { botId: "dog", folder, command: "sleep 2; echo done > out.txt" });
    const first = await runs.finish(box, started);
    expect(first.state).toBe("running");
    expect(first.note).toContain(started.id);
    const record = runs.record("dog", started.id)!;
    await new Promise((done) => setTimeout(done, 2500));
    const second = await runs.finish(box, record);
    expect(second.state).toBe("finished");
    expect(readFileSync(join(folder, "out.txt"), "utf8")).toBe("done\n");
  });
});

function computerShell(home: string, repoDir: string, runKey: string) {
  return (script: string) => {
    const out = spawnSync("bash", ["-c", script], { cwd: home, encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, LATERDOG_REPOSITORY: "acme/site", LATERDOG_REPOSITORY_DIR: repoDir, LATERDOG_RUN_KEY: runKey } });
    return { exitCode: out.status, stdout: out.stdout, stderr: out.stderr };
  };
}

const git = (cwd: string, ...args: string[]) => {
  const out = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  if (out.status !== 0) throw new Error(out.stderr);
  return out.stdout;
};

describe("a repository environment on the dog's computer", () => {
  it("leaves its packages where run_on_computer reuses them for a session's copy with the same lockfile", async () => {
    const { folder, computer, state } = project();
    mkdirSync(computer);
    writeFileSync(join(folder, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const repoDir = join(computer, "repos/acme/site");
    mkdirSync(join(repoDir, "node_modules/left-pad"), { recursive: true });
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(repoDir, "node_modules/left-pad/index.js"), "from the environment");
    const runKey = await environments.setupRunKey("acme/site");
    const shell = computerShell(computer, repoDir, runKey);
    expect(shell(environments.REGISTER_SCRIPT).exitCode).toBe(0);
    expect(readFileSync(join(computer, "runs/.setup", setupKey(folder)!), "utf8").trim()).toBe(runKey);
    expect(readlinkSync(join(computer, "runs", runKey))).toBe(repoDir);
    expect(shell(`${environments.ENVIRONMENT_PRELUDE}\ncd ${JSON.stringify(repoDir)} && laterdog_lock_key`).stdout.trim()).toBe(setupKey(folder));

    const { box } = localBox(computer);
    const outcome = await new ComputerRuns(state, fast).run(box, { botId: "dog", folder, command: "cat node_modules/left-pad/index.js" });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toContain("from the environment");
    expect(outcome.note).toContain("Reused the packages");
  });

  it("fetches on wake and installs again only when the lockfile changed", async () => {
    const root = mkdtempSync(join(tmpdir(), "environment-maintenance-"));
    const computer = join(root, "computer");
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    mkdirSync(join(computer, ".local/bin"), { recursive: true });
    writeFileSync(join(computer, ".local/bin/pnpm"), "#!/bin/sh\necho \"$@\" >> \"$HOME/pnpm-calls\"\nmkdir -p node_modules/.installed\n");
    chmodSync(join(computer, ".local/bin/pnpm"), 0o755);
    git(root, "init", "-q", "--bare", origin);
    git(root, "clone", "-q", origin, work);
    writeFileSync(join(work, "package.json"), "{}\n");
    writeFileSync(join(work, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "first");
    git(work, "push", "-q", "origin", "HEAD:main");
    const repoDir = join(computer, "repos/acme/site");
    mkdirSync(dirname(repoDir), { recursive: true });
    git(root, "clone", "-q", "--branch", "main", origin, repoDir);
    mkdirSync(join(repoDir, "node_modules"));
    const shell = computerShell(computer, repoDir, await environments.setupRunKey("acme/site"));
    expect(shell(environments.REGISTER_SCRIPT).exitCode).toBe(0);

    const unchanged = shell(environments.MAINTENANCE_SCRIPT);
    expect(environments.maintenanceFrom(unchanged.stdout)).toEqual({ fetched: "yes", installed: "no" });
    expect(existsSync(join(computer, "pnpm-calls"))).toBe(false);

    writeFileSync(join(work, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages: {}\n");
    git(work, "commit", "-q", "-am", "new lockfile");
    git(work, "push", "-q", "origin", "HEAD:main");
    const changed = shell(environments.MAINTENANCE_SCRIPT);
    expect(environments.maintenanceFrom(changed.stdout)).toEqual({ fetched: "yes", installed: "yes" });
    expect(readFileSync(join(repoDir, "pnpm-lock.yaml"), "utf8")).toContain("packages: {}");
    expect(readFileSync(join(computer, "pnpm-calls"), "utf8")).toBe("install --frozen-lockfile --prefer-offline\n");
    expect(existsSync(join(computer, "runs/.setup", setupKey(repoDir)!))).toBe(true);

    expect(environments.maintenanceFrom(shell(environments.MAINTENANCE_SCRIPT).stdout)).toEqual({ fetched: "yes", installed: "no" });
    const missing = computerShell(computer, join(computer, "repos/acme/none"), "0000000000000000");
    expect(environments.maintenanceFrom(missing(environments.MAINTENANCE_SCRIPT).stdout)).toEqual({ fetched: "no_checkout", installed: "no" });
  });
});

describe("the pieces", () => {
  it("compares folder stamps and skips build output", () => {
    const { folder } = project();
    const stamps = stampFolder(folder);
    expect(Object.keys(stamps).sort()).toEqual(["package.json", "src/page.ts"]);
    expect(changesSince({ "a": { size: 1, mtimeMs: 1 }, "b": { size: 1, mtimeMs: 1 } }, { "a": { size: 2, mtimeMs: 1 }, "c": { size: 1, mtimeMs: 1 } })).toEqual({ changed: ["a", "c"], removed: ["b"] });
  });

  it("brings back files up to the size limit and never build output or paths that leave the folder", () => {
    expect(bringBackList("10\t./a.txt\n5\t./node_modules/x.js\n7\t./../escape\n20\t./big.bin\n3\t./c.txt\n", 15)).toEqual({ take: ["a.txt", "c.txt"], skipped: ["big.bin"] });
  });

  it("splits large archives into parts the computer accepts", () => {
    expect(parts(Buffer.alloc(25), 10).map((part) => part.length)).toEqual([10, 10, 5]);
    expect(parts(Buffer.alloc(0), 10)).toHaveLength(1);
  });
});
