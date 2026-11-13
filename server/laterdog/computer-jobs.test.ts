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
const probe = (over: Partial<ComputerJobProbe> = {}): ComputerJobProbe => ({ box: async () => box, outcome: async () => null, ...over });

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

  it("ends a job once the computer says it finished, or once the computer is not running at all, and keeps how it ended to tell the dog", async () => {
    const jobs = new ComputerJobs(null, { now: () => 2_000 });
    jobs.started(job({ id: "aaaa0001" }));
    jobs.started(job({ id: "aaaa0002", botId: "asleep" }));
    jobs.started(job({ id: "aaaa0003" }));
    jobs.started(job({ id: "aaaa0004" }));
    const exits: Record<string, number> = { aaaa0001: 0, aaaa0004: 2 };
    const ended = await jobs.check(probe({ box: async (botId) => (botId === "asleep" ? null : box), outcome: async (_box, j) => (j.id in exits ? { exitCode: exits[j.id]! } : null) }));
    expect(ended.sort()).toEqual(["aaaa0001", "aaaa0002", "aaaa0004"]);
    expect(jobs.live("t1").map((j) => j.id)).toEqual(["aaaa0003"]);
    expect(jobs.unannounced().map((j) => [j.id, j.end.how, j.end.exitCode])).toEqual([["aaaa0001", "finished", 0], ["aaaa0002", "stopped", undefined], ["aaaa0004", "failed", 2]]);
  });

  it("forgets a job the dog read itself, and every job of a chat the person stopped", () => {
    const jobs = new ComputerJobs(null);
    jobs.started(job({ id: "aaaa0001" }));
    jobs.finished("aaaa0001", { how: "finished", exitCode: 0, at: 5 });
    jobs.ended("aaaa0001");
    expect(jobs.unannounced()).toEqual([]);
    jobs.started(job({ id: "aaaa0002" }));
    jobs.started(job({ id: "aaaa0003" }));
    jobs.finished("aaaa0003", { how: "failed", exitCode: 1, at: 5 });
    expect(jobs.quiet("t1").map((j) => j.id)).toEqual(["aaaa0002"]);
    expect(jobs.unannounced()).toEqual([]);
    expect(jobs.count("t1")).toBe(0);
  });

  it("remembers an ending it has not told the dog about across a restart, and forgets it once told", () => {
    const file = join(dir, "told.json");
    const before = new ComputerJobs(file);
    before.started(job());
    before.finished("abcd1234", { how: "finished", exitCode: 0, at: 5 });
    const after = new ComputerJobs(file);
    expect(after.unannounced().map((j) => j.id)).toEqual(["abcd1234"]);
    after.announced(["abcd1234"]);
    expect(new ComputerJobs(file).unannounced()).toEqual([]);
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
    expect(jobs.unannounced()[0]?.end.how).toBe("stopped");
  });

  it("leaves a job alone while a call is already waiting on it", async () => {
    const jobs = new ComputerJobs(null, { now: () => 2_000 });
    jobs.started(job());
    const release = jobs.hold("abcd1234");
    expect(await jobs.check(probe({ outcome: async () => ({ exitCode: 0 }) }))).toEqual([]);
    release();
    expect(await jobs.check(probe({ outcome: async () => ({ exitCode: 0 }) }))).toEqual(["abcd1234"]);
  });
});
