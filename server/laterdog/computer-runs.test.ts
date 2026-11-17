import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { bringBackList, changesSince, ComputerRuns, parts, type RunBox, type RunRecord, runKey, setupKey, stampFolder } from "./computer-runs.ts";

const ENVIRONMENTS_MODULE = "../../deploy/laterdog/computers/src/environments.ts";
const environments = await import(ENVIRONMENTS_MODULE);

function localBox(home: string) {
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(join(home, ".local/bin/pnpm"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(home, ".local/bin/pnpm"), 0o755);
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

  it("runs in a subfolder that is still empty on the home and brings back what it made there", async () => {
    const { folder, computer, state } = project();
    mkdirSync(computer);
    mkdirSync(join(folder, "pub"));
    const { box } = localBox(computer);
    const runs = new ComputerRuns(state, fast);
    const outcome = await runs.run(box, { botId: "dog", folder, subdir: "pub", command: "pwd; echo made > made.txt" });
    expect(outcome.state).toBe("finished");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toMatch(/\/pub\n/);
    expect(outcome.broughtBack).toEqual(["pub/made.txt"]);
    expect(readFileSync(join(folder, "pub/made.txt"), "utf8")).toBe("made\n");
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

  it("brings back an output whose time equals the run's start marker, never an untouched older file, build output or a file changed here", async () => {
    const { folder, computer, state } = project();
    mkdirSync(computer);
    const { box } = localBox(computer);
    const runs = new ComputerRuns(state, fast);
    const started = await runs.start(box, { botId: "dog", folder, command: "mkdir -p dist && echo built > dist/app.js && echo result-7f3a > report.txt && echo theirs > src/page.ts" });
    while (!existsSync(join(computer, "runs/.logs", `${started.id}.exit`))) await new Promise((done) => setTimeout(done, 20));
    const remote = join(computer, "runs", started.key);
    const marker = join(computer, "runs/.logs", `${started.id}.start`);
    expect(spawnSync("touch", ["-r", marker, "report.txt", "src/page.ts", "dist/app.js"], { cwd: remote }).status).toBe(0);
    expect(statSync(join(remote, "report.txt"), { bigint: true }).mtimeNs).toBe(statSync(marker, { bigint: true }).mtimeNs);
    writeFileSync(join(folder, "src/page.ts"), "mine\n");
    const outcome = await runs.finish(box, started);
    expect(outcome.state).toBe("finished");
    expect(outcome.broughtBack).toEqual(["report.txt"]);
    expect(readFileSync(join(folder, "report.txt"), "utf8")).toBe("result-7f3a\n");
    expect(outcome.note).toContain("src/page.ts");
    expect(readFileSync(join(folder, "src/page.ts"), "utf8")).toBe("mine\n");
    expect(existsSync(join(folder, "dist"))).toBe(false);
    expect(readFileSync(join(folder, "package.json"), "utf8")).toBe("{}");
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
    expect(first.note).toBe(`Still running. Call run_on_computer again with run_id "${started.id}" to keep waiting. That call waits up to its wait_minutes (default 4).`);
    const record = runs.record("dog", started.id)!;
    await new Promise((done) => setTimeout(done, 2500));
    const second = await runs.finish(box, record);
    expect(second.state).toBe("finished");
    expect(readFileSync(join(folder, "out.txt"), "utf8")).toBe("done\n");
  });

  it("never finds its own shell when it asks the computer whether a run is still going", async () => {
    const { folder, computer, state } = project();
    mkdirSync(computer);
    const { box, commands } = localBox(computer);
    const runs = new ComputerRuns(state, fast);
    const started = await runs.start(box, { botId: "dog", folder, command: "sleep 5" });
    const outcome = await runs.finish(box, runs.record("dog", started.id)!, undefined, runs.window(1));
    spawnSync("pkill", ["-f", `runs/[.]logs/${started.id}[.]log`]);
    expect(outcome.state).toBe("running");
    for (const command of commands.filter((command) => /pgrep -f /.test(command))) expect(searchesItself(command, "pgrep"), command).toBe(false);
    const afterStart = commands.slice(commands.findIndex((command) => command.includes("nohup")) + 1);
    expect(afterStart.length).toBeGreaterThan(0);
    for (const command of afterStart) expect(command, command).not.toContain(`runs/.logs/${started.id}.log`);
  });

  it("reads a run whose liveness says dead as not gone once its exit record has appeared", async () => {
    const { state } = project();
    const runs = new ComputerRuns(state, fast);
    const record = { id: "abcd1234" } as RunRecord;
    let exit = "";
    const box = { exec: async (command: string) => ({ exitCode: 0, stdout: command.includes(".pgid") ? "marked\n" : `${exit}<<<\nlog`, stderr: "" }), write: async () => undefined, read: async () => Buffer.alloc(0) } as RunBox;
    runs.liveness = async () => "dead";
    expect(await runs.gone(box, record)).toBe(true);
    exit = "0\n";
    expect(await runs.gone(box, record)).toBe(false);
  });

  it("never reads a run started before this home updated as gone while it still runs", async () => {
    const { folder, computer, state } = project();
    mkdirSync(join(computer, "runs/.logs"), { recursive: true });
    const id = "00d0c0de";
    spawnSync("bash", ["-c", `setsid nohup bash -lc 'sleep 31.7' > runs/.logs/${id}.log 2>&1 < /dev/null &`], { cwd: computer });
    const { box } = localBox(computer);
    const runs = new ComputerRuns(state, fast);
    const record: RunRecord = { id, botId: "dog", key: runKey(folder), folder, subdir: "", command: "sleep 31.7", startedAt: Date.now(), sent: {} };
    try {
      expect(await runs.liveness(box, record)).toBe("dead");
      expect(await runs.gone(box, record)).toBe(false);
      const outcome = await runs.finish(box, record, undefined, runs.window(1));
      expect(outcome.state).toBe("running");
      expect(outcome.exitCode).toBeNull();
    } finally {
      spawnSync("pkill", ["-f", "sleep 31[.]7"]);
    }
  });

  it("never reads a run as gone when its liveness is unsure, alive or cannot be read", async () => {
    const { state } = project();
    const runs = new ComputerRuns(state, fast);
    const record = { id: "abcd1234" } as RunRecord;
    const box = { exec: async () => ({ exitCode: 0, stdout: "<<<\nlog", stderr: "" }), write: async () => undefined, read: async () => Buffer.alloc(0) } as RunBox;
    for (const said of ["unsure", "alive", "exited"] as const) {
      runs.liveness = async () => said;
      expect(await runs.gone(box, record), said).toBe(false);
    }
    runs.liveness = async () => { throw new Error("the computer did not answer"); };
    expect(await runs.gone(box, record)).toBe(false);
  });

  it("asks whether a run is still going only while it has no exit code", async () => {
    const { folder, computer, state } = project();
    mkdirSync(computer);
    const { box, commands } = localBox(computer);
    const runs = new ComputerRuns(state, fast);
    const started = await runs.start(box, { botId: "dog", folder, command: "true" });
    for (let tries = 0; tries < 50 && !existsSync(join(computer, `runs/.logs/${started.id}.exit`)); tries += 1) spawnSync("sleep", ["0.1"]);
    const outcome = await runs.finish(box, runs.record("dog", started.id)!, undefined, runs.window(60_000));
    expect(outcome.state).toBe("finished");
    expect(commands.filter((command) => /pgrep/.test(command))).toEqual([]);
  });

  it("stops a run that passed 2 hours without its kill finding the shell that sends it", async () => {
    const { folder, computer, state } = project();
    mkdirSync(computer);
    const { box, commands } = localBox(computer);
    const clock = { at: 1_000_000 };
    const runs = new ComputerRuns(state, { now: () => clock.at, sleep: async () => undefined });
    const started = await runs.start(box, { botId: "dog", folder, command: "sleep 30" });
    clock.at += 3 * 60 * 60_000;
    const outcome = await runs.finish(box, runs.record("dog", started.id)!, undefined, () => 1);
    expect(outcome.note).toBe("Stopped after 2 hours.");
    for (const kill of commands.filter((command) => /pkill -f /.test(command))) expect(searchesItself(kill, "pkill"), kill).toBe(false);
    for (let tries = 0; tries < 50 && spawnSync("pgrep", ["-f", `runs/[.]logs/${started.id}[.]log`]).status === 0; tries += 1) spawnSync("sleep", ["0.1"]);
    expect(spawnSync("pgrep", ["-f", `runs/[.]logs/${started.id}[.]log`]).status).not.toBe(0);
  });

  it("says a run is over when its command is gone without finishing, instead of waiting up to 2 hours", async () => {
    const { folder, computer, state } = project();
    mkdirSync(computer);
    const { box } = localBox(computer);
    const runs = new ComputerRuns(state, fast);
    const started = await runs.start(box, { botId: "dog", folder, command: "sleep 5" });
    const pattern = `runs/[.]logs/${started.id}[.]log`;
    for (let tries = 0; tries < 50 && !existsSync(join(computer, `runs/.logs/${started.id}.pgid`)); tries += 1) spawnSync("sleep", ["0.1"]);
    spawnSync("pkill", ["-f", pattern]);
    for (let tries = 0; tries < 50 && spawnSync("pgrep", ["-f", pattern]).status === 0; tries += 1) spawnSync("sleep", ["0.1"]);
    const outcome = await runs.finish(box, runs.record("dog", started.id)!, undefined, runs.window(60_000));
    expect(outcome.state).toBe("failed");
    expect(outcome.note).toBe("It stopped before finishing and left no exit code. Run it again if you still need its result.");
  });
});

function searchesItself(command: string, tool: "pgrep" | "pkill"): boolean {
  return [...command.matchAll(new RegExp(`${tool} -f '([^']+)'`, "g"))].some((match) => new RegExp(match[1]!).test(command));
}

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


describe("generated transfer paths", () => {
  it("leaves all 252 generated files on the computer while returning source and results", async () => {
    const { folder, computer, state } = project(); mkdirSync(computer);
    mkdirSync(join(folder, ".open-next")); writeFileSync(join(folder, ".open-next/keep.js"), "home copy");
    const { box } = localBox(computer);
    const outcome = await new ComputerRuns(state, fast).run(box, { botId: "dog", folder,
      command: "mkdir -p apps/site/.open-next/assets apps/site/.wrangler/tmp/dev apps/site/.wrangler/state apps/site/.wrangler/cache results .git; for i in $(seq 1 252); do echo generated > apps/site/.open-next/assets/$i.js; done; echo scratch > apps/site/.wrangler/tmp/dev/x; echo state > apps/site/.wrangler/state/db; echo cache > apps/site/.wrangler/cache/x; echo source > src/page.ts; echo result > results/check.txt; echo ref > .git/HEAD" });
    expect(outcome.broughtBack.sort()).toEqual([".git/HEAD", "apps/site/.wrangler/cache/x", "apps/site/.wrangler/state/db", "results/check.txt", "src/page.ts"]);
    expect(outcome.sentFiles).toBe(2);
    expect(existsSync(join(folder, "apps/site/.open-next"))).toBe(false);
    expect(readFileSync(join(folder, ".open-next/keep.js"), "utf8")).toBe("home copy");
    expect(readFileSync(join(computer, "runs", runKey(folder), "apps/site/.open-next/assets/252.js"), "utf8")).toBe("generated\n");
  });
  it("filters legacy stamps before removal while still deleting removed real source remotely", async () => {
    const { folder, computer, state } = project(); mkdirSync(computer);
    const key = runKey(folder); const remote = join(computer, "runs", key);
    const oldPaths = [".open-next/assets/old.js", "apps/site/.wrangler/tmp/old.js", "src/deleted.ts"];
    for (const path of oldPaths) { mkdirSync(dirname(join(remote, path)), { recursive: true }); writeFileSync(join(remote, path), "retained"); }
    mkdirSync(join(state, "dog"), { recursive: true });
    writeFileSync(join(state, "dog", `${key}.sent.json`), JSON.stringify(Object.fromEntries(oldPaths.map(path => [path, { size: 8, mtimeMs: 1 }]))));
    const { box } = localBox(computer);
    await new ComputerRuns(state, fast).run(box, { botId: "dog", folder, command: "true" });
    for (const path of oldPaths.slice(0, 2)) expect(readFileSync(join(remote, path), "utf8")).toBe("retained");
    expect(existsSync(join(remote, "src/deleted.ts"))).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(join(state, "dog", `${key}.sent.json`), "utf8")))).not.toEqual(expect.arrayContaining(oldPaths.slice(0, 2)));
  });
  it("excludes generated paths consistently from stamps, deltas and returned lists", () => {
    const { folder } = project();
    const skip = [".open-next/a", "apps/site/.open-next/a", "apps/site/.wrangler/tmp/dev/a"];
    const keep = ["apps/site/.wrangler/state/db", "apps/site/.wrangler/cache/db", "src/tmp/a", "results/a", ".git/HEAD"];
    for (const path of [...skip, ...keep]) { mkdirSync(dirname(join(folder, path)), { recursive: true }); writeFileSync(join(folder, path), "x"); }
    const stamps = stampFolder(folder);
    for (const path of skip) expect(stamps[path], path).toBeUndefined();
    for (const path of keep) expect(stamps[path], path).toBeTruthy();
    expect(changesSince(Object.fromEntries(skip.map(path => [path, { size: 1, mtimeMs: 1 }])), {})).toEqual({ changed: [], removed: [] });
    expect(bringBackList([...skip, ...keep].map(path => `1\t./${path}`).join("\n")).take).toEqual(keep);
  });
  it("rejects malicious listing and legacy-stamp paths before transfer or removal", () => {
    const paths = ["../outside", "/absolute", "a/../../outside", "a//b", "a/./b", "a\\b", "a\0b", "a\tb"];
    for (const path of paths) {
      expect(bringBackList(`1\t${path}`).take, path).toEqual([]);
      expect(changesSince({ [path]: { size: 1, mtimeMs: 1 } }, {}), path).toEqual({ changed: [], removed: [] });
    }
    for (const size of ["NaN", "-1", "Infinity", "1.5"]) expect(bringBackList(`${size}\tsrc/a`).take).toEqual([]);
    expect(bringBackList("10\tsrc/a\n20\tresults/b\n1\tresults/c", 15)).toEqual({ take: ["src/a", "results/c"], skipped: ["results/b"] });
  });

});
