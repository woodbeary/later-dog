import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  it.each([
    ["a plain command", "sleep 3171"],
    ["a command followed by more", "sleep 3172; echo done"],
    ["a command inside another shell", "bash -c 'sleep 3173; true'"],
  ])("stops %s itself, not only its wrapper", async (_name, command) => {
    const home = mkdtempSync(join(dir, "home-"));
    const folder = mkdtempSync(join(dir, "folder-"));
    writeFileSync(join(folder, "a.txt"), "a\n");
    const box = localBox(home);
    const runs = new ComputerRuns(join(dir, "state"));
    const record = await runs.start(box, { botId: "dog", folder, command });
    const pattern = command.match(/sleep \d+/)![0];
    expect(await until(() => alive(pattern))).toBe(true);
    expect(await runs.stop(box, record)).toBe(true);
    expect(await until(() => !alive(pattern))).toBe(true);
  }, 30_000);

  it("removes a job only once its end is confirmed, and keeps it with a line when it could not be stopped", async () => {
    const jobs = new ComputerJobs(null);
    const job = (id: string, botId: string): ComputerJob => ({ id, botId, threadId: "t1", command: "pnpm dev", startedAt: 1 });
    jobs.started(job("aaaa0001", "stops"));
    jobs.started(job("aaaa0002", "stuck"));
    jobs.started(job("aaaa0003", "asleep"));
    const told: string[] = [];
    const running: JobComputer = { state: "running", box: {} as RunBox };
    const result = await stopComputerJobs(jobs, "t1", {
      computer: async (botId) => (botId === "asleep" ? { state: "asleep" } : running),
      stop: async (_box, j) => j.botId === "stops",
      couldNotStop: (_threadId, j) => told.push(j.id),
    });
    expect(result).toEqual({ stopped: ["aaaa0001", "aaaa0003"], left: ["aaaa0002"] });
    expect(told).toEqual(["aaaa0002"]);
    expect(jobs.live("t1").map((j) => j.id)).toEqual(["aaaa0002"]);
  });
});
