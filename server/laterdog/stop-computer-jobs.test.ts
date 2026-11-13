import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { ComputerJobs, type ComputerJob, type JobComputer } from "./computer-jobs.ts";
import { ComputerRuns, type RunBox } from "./computer-runs.ts";
import { stopComputerJobs } from "./stop-computer-jobs.ts";

const dir = mkdtempSync(join(tmpdir(), "stop-jobs-"));
afterAll(() => removeTempDir(dir));

function localBox(home: string): RunBox {
  return {
    exec: (command, timeoutMs) => new Promise((resolve) => {
      const run = spawn("bash", ["-c", command], { cwd: home, env: { PATH: process.env.PATH, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      run.stdout.on("data", (part) => { stdout += part; });
      run.stderr.on("data", (part) => { stderr += part; });
      const timer = setTimeout(() => run.kill("SIGKILL"), timeoutMs);
      run.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code, stdout, stderr }); });
    }),
    write: async (path, bytes) => { mkdirSync(dirname(join(home, path)), { recursive: true }); writeFileSync(join(home, path), bytes); },
    read: async (path) => readFileSync(join(home, path)),
  };
}

const alive = (pattern: string) => spawnSync("pgrep", ["-f", pattern]).status === 0;
const until = async (check: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  return check();
};

describe("stopping a command on the dog's computer", () => {
  const launch = async (command: string) => {
    const home = mkdtempSync(join(dir, "home-"));
    const folder = mkdtempSync(join(dir, "folder-"));
    writeFileSync(join(folder, "a.txt"), "a\n");
    writeFileSync(join(folder, "daemon.py"), "import os, time\nif os.fork() == 0:\n    os.setsid()\n    if os.fork() == 0:\n        time.sleep(3174)\n    os._exit(0)\n");
    const box = localBox(home);
    const runs = new ComputerRuns(join(dir, "state"));
    const record = await runs.start(box, { botId: "dog", folder, command });
    return { home, box, runs, record };
  };

  it.each([
    ["a plain command", "sleep 3171", "sleep 3171"],
    ["a command followed by more", "sleep 3172; echo done", "sleep 3172"],
    ["a command inside another shell", "bash -c 'sleep 3173; true'", "sleep 3173"],
    ["a command that starts its own session", "python3 daemon.py; sleep 3175", "daemon.py"],
  ])("stops %s itself, not only its wrapper", async (_name, command, pattern) => {
    const { box, runs, record } = await launch(command);
    expect(await until(() => alive(pattern))).toBe(true);
    expect(await runs.liveness(box, record)).toBe("alive");
    expect(await runs.stop(box, record)).toBe("gone");
    expect(await until(() => !alive(pattern))).toBe(true);
    expect(alive("sleep 3175")).toBe(false);
  }, 40_000);

  it("finds a job whose processes died without an exit record dead, and Stop clears it even with its group id gone", async () => {
    const { home, box, runs, record } = await launch("sleep 3176");
    expect(await until(() => alive("sleep 3176"))).toBe(true);
    const pg = readFileSync(join(home, "runs/.logs", `${record.id}.pgid`), "utf8").trim();
    spawnSync("kill", ["-KILL", `-${pg}`]);
    rmSync(join(home, "runs/.logs", `${record.id}.pgid`));
    expect(await until(() => !alive("sleep 3176"))).toBe(true);
    expect(await runs.liveness(box, record)).toBe("dead");
    expect(await runs.stop(box, record)).toBe("gone");
  }, 30_000);

  it("removes a job only once its end is confirmed, says when part of it may still run, keeps it with a line when it could not be stopped, and leaves a sleeping computer's job to the watch", async () => {
    const jobs = new ComputerJobs(null);
    const job = (id: string, botId: string): ComputerJob => ({ id, botId, threadId: "t1", command: "pnpm dev", startedAt: 1 });
    jobs.started(job("aaaa0001", "stops"));
    jobs.started(job("aaaa0002", "stuck"));
    jobs.started(job("aaaa0003", "asleep"));
    jobs.started(job("aaaa0004", "partly"));
    const told: string[] = [];
    const running: JobComputer = { state: "running", box: {} as RunBox };
    const result = await stopComputerJobs(jobs, "t1", {
      computer: async (botId) => (botId === "asleep" ? { state: "asleep" } : running),
      stop: async (_box, j) => (j.botId === "stops" ? "gone" : j.botId === "partly" ? "partial" : "alive"),
      couldNotStop: (_threadId, j) => told.push(`left ${j.id}`),
      partlyStopped: (_threadId, j) => told.push(`partly ${j.id}`),
    });
    expect(result).toEqual({ stopped: ["aaaa0001"], partly: ["aaaa0004"], left: ["aaaa0002", "aaaa0003"] });
    expect(told).toEqual(["left aaaa0002", "partly aaaa0004"]);
    expect(jobs.live("t1").map((j) => j.id)).toEqual(["aaaa0002", "aaaa0003"]);
  });
});
