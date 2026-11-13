import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { ComputerJobs, type ComputerJob, type ComputerJobProbe, type JobComputer } from "./computer-jobs.ts";
import { MAX_RUN_MS, type RunBox } from "./computer-runs.ts";

const dir = mkdtempSync(join(tmpdir(), "computer-jobs-"));
afterAll(() => removeTempDir(dir));
const box = {} as RunBox;
const running: JobComputer = { state: "running", box };
const job = (over: Partial<ComputerJob> = {}): ComputerJob => ({ id: "abcd1234", botId: "dog", threadId: "t1", command: "pnpm test", startedAt: 1_000, ...over });
const probe = (over: Partial<ComputerJobProbe> = {}): ComputerJobProbe => ({ computer: async () => running, exit: async () => null, ...over });

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

  it("moves an unreadable ledger aside, says so, and starts empty", () => {
    const file = join(dir, "corrupt.json");
    writeFileSync(file, "{not json");
    const said: string[] = [];
    const jobs = new ComputerJobs(file, { log: (line) => said.push(line) });
    expect(jobs.count("t1")).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir).some((name) => name.startsWith("corrupt.json.corrupt-"))).toBe(true);
    expect(said[0]).toContain("unreadable");
  });

  it("ends a job only on evidence: its exit record, or its computer asleep, or seen gone twice", async () => {
    const jobs = new ComputerJobs(null, { now: () => 9_000 });
    jobs.started(job({ id: "aaaa0001" }));
    jobs.started(job({ id: "aaaa0002", botId: "asleep" }));
    jobs.started(job({ id: "aaaa0003" }));
    jobs.started(job({ id: "aaaa0004" }));
    jobs.started(job({ id: "aaaa0005", botId: "gone" }));
    const exits: Record<string, { exitCode: number; at?: number }> = { aaaa0001: { exitCode: 0, at: 5_000 }, aaaa0004: { exitCode: 2 } };
    const look = probe({
      computer: async (botId) => (botId === "asleep" ? { state: "asleep" } : botId === "gone" ? { state: "gone" } : running),
      exit: async (_box, j) => exits[j.id] ?? null,
    });
    expect((await jobs.check(look)).sort()).toEqual(["aaaa0001", "aaaa0002", "aaaa0004"]);
    expect(jobs.live("t1").map((j) => j.id)).toEqual(["aaaa0003", "aaaa0005"]);
    expect(await jobs.check(look)).toEqual(["aaaa0005"]);
    expect(jobs.unannounced().map((j) => [j.id, j.end.how, j.end.exitCode, j.end.at])).toEqual([
      ["aaaa0001", "finished", 0, 5_000], ["aaaa0002", "stopped", undefined, 9_000], ["aaaa0004", "failed", 2, 9_000], ["aaaa0005", "stopped", undefined, 9_000],
    ]);
  });

  it("changes nothing when the computer is in any other state or cannot be asked", async () => {
    const jobs = new ComputerJobs(null);
    jobs.started(job());
    expect(await jobs.check(probe({ computer: async () => ({ state: "unsure" }) }))).toEqual([]);
    expect(await jobs.check(probe({ computer: async () => { throw new Error("network"); } }))).toEqual([]);
    expect(await jobs.check(probe({ computer: async () => ({ state: "gone" }) }))).toEqual([]);
    expect(await jobs.check(probe())).toEqual([]);
    expect(await jobs.check(probe({ computer: async () => ({ state: "gone" }) }))).toEqual([]);
    expect(jobs.count("t1")).toBe(1);
  });

  it("never declares a long job ended: past the longest a run may take it is still running", async () => {
    let now = 1_000;
    const jobs = new ComputerJobs(null, { now: () => now });
    jobs.started(job());
    now = 1_000 + MAX_RUN_MS + 60 * 60_000;
    expect(await jobs.check(probe())).toEqual([]);
    expect(jobs.count("t1")).toBe(1);
    expect(jobs.unannounced()).toEqual([]);
  });

  it("forgets a job the dog read itself; the person's Stop keeps a job shown until its end is confirmed and never announces it", async () => {
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
    expect(jobs.count("t1")).toBe(1);
    await jobs.check(probe({ exit: async () => ({ exitCode: 143 }) }));
    expect(jobs.count("t1")).toBe(0);
    expect(jobs.unannounced()).toEqual([]);
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

  it("leaves a job alone while a call is already waiting on it", async () => {
    const jobs = new ComputerJobs(null, { now: () => 2_000 });
    jobs.started(job());
    const release = jobs.hold("abcd1234");
    expect(await jobs.check(probe({ exit: async () => ({ exitCode: 0 }) }))).toEqual([]);
    release();
    expect(await jobs.check(probe({ exit: async () => ({ exitCode: 0 }) }))).toEqual(["abcd1234"]);
  });
});
