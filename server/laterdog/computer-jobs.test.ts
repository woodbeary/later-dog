import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { ComputerJobs, JOB_GRACE_MS, type ComputerJob, type ComputerJobProbe } from "./computer-jobs.ts";
import { MAX_RUN_MS, type RunBox } from "./computer-runs.ts";

const dir = mkdtempSync(join(tmpdir(), "computer-jobs-"));
afterAll(() => removeTempDir(dir));
const box = {} as RunBox;
const job = (over: Partial<ComputerJob> = {}): ComputerJob => ({ id: "abcd1234", botId: "dog", threadId: "t1", command: "pnpm test", startedAt: 1_000, ...over });
const probe = (over: Partial<ComputerJobProbe> = {}): ComputerJobProbe => ({ box: async () => box, done: async () => false, ...over });

describe("jobs a dog left running on its computer", () => {
  it("counts a job for its chat until it ends, and tells the chat each time", () => {
    const changed: string[] = [];
    const jobs = new ComputerJobs(null, { changed: (id) => changed.push(id) });
    jobs.started(job());
    expect(jobs.count("t1")).toBe(1);
    expect(jobs.count("t2")).toBe(0);
    jobs.ended("abcd1234");
    expect(jobs.count("t1")).toBe(0);
    expect(changed).toEqual(["t1", "t1"]);
  });

  it("survives a restart of the home, from its ledger", () => {
    const file = join(dir, "restart.json");
    new ComputerJobs(file).started(job());
    expect(new ComputerJobs(file).live("t1")).toEqual([job()]);
  });

  it("ends a job once the computer says it finished, or once the computer is not running at all", async () => {
    const jobs = new ComputerJobs(null, { now: () => 2_000 });
    jobs.started(job({ id: "aaaa0001" }));
    jobs.started(job({ id: "aaaa0002", botId: "asleep" }));
    jobs.started(job({ id: "aaaa0003" }));
    const ended = await jobs.check(probe({ box: async (botId) => (botId === "asleep" ? null : box), done: async (_box, j) => j.id === "aaaa0001" }));
    expect(ended.sort()).toEqual(["aaaa0001", "aaaa0002"]);
    expect(jobs.live("t1").map((j) => j.id)).toEqual(["aaaa0003"]);
  });

  it("keeps a job it could not check, but never past the longest a run may take", async () => {
    let now = 2_000;
    const jobs = new ComputerJobs(null, { now: () => now });
    jobs.started(job());
    const unreachable = probe({ box: async () => { throw new Error("network"); } });
    expect(await jobs.check(unreachable)).toEqual([]);
    expect(jobs.count("t1")).toBe(1);
    now = 1_000 + MAX_RUN_MS + JOB_GRACE_MS;
    expect(await jobs.check(unreachable)).toEqual(["abcd1234"]);
    expect(jobs.count("t1")).toBe(0);
  });

  it("leaves a job alone while a call is already waiting on it", async () => {
    const jobs = new ComputerJobs(null, { now: () => 2_000 });
    jobs.started(job());
    const release = jobs.hold("abcd1234");
    expect(await jobs.check(probe({ done: async () => true }))).toEqual([]);
    release();
    expect(await jobs.check(probe({ done: async () => true }))).toEqual(["abcd1234"]);
  });
});
