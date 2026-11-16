import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { cloudComputerStartBudgetMs } from "./cloud-start.ts";
import { ComputerJobs, JOB_CHECK_MS, UNREADABLE_MS, type ComputerJob, type ComputerJobProbe, type JobComputer } from "./computer-jobs.ts";
import { MAX_RUN_MS, type RunBox } from "./computer-runs.ts";

const dir = mkdtempSync(join(tmpdir(), "computer-jobs-"));
afterAll(() => removeTempDir(dir));
const box = {} as RunBox;
const running: JobComputer = { state: "running", box };
const job = (over: Partial<ComputerJob> = {}): ComputerJob => ({ id: "abcd1234", botId: "dog", threadId: "t1", command: "pnpm test", startedAt: 1_000, ...over });
const probe = (over: Partial<ComputerJobProbe> = {}): ComputerJobProbe => ({ computer: async () => running, exit: async () => null, liveness: async () => "alive", stop: async () => "gone", ...over });

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

  it("describes a chat's live jobs: how many, since when, and how many are past the longest a run may take", () => {
    let now = 50_000;
    const jobs = new ComputerJobs(null, { now: () => now });
    expect(jobs.facts("t1")).toEqual({});
    jobs.started(job({ id: "aaaa0001", startedAt: 20_000 }));
    jobs.started(job({ id: "aaaa0002", startedAt: 10_000 }));
    jobs.started(job({ id: "aaaa0003", startedAt: 5_000 }));
    jobs.finished("aaaa0003", { how: "finished", exitCode: 0, at: 6_000 });
    expect(jobs.facts("t1")).toEqual({ computerJobs: 2, computerSince: 10_000 });
    now = 15_000 + MAX_RUN_MS;
    expect(jobs.facts("t1")).toEqual({ computerJobs: 2, computerSince: 10_000, computerBackground: 1 });
    expect(jobs.facts("t2")).toEqual({});
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

  it("ends a job on its exit record at once, and on its computer asleep or missing only on two readings in a row", async () => {
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
    expect((await jobs.check(look)).sort()).toEqual(["aaaa0001", "aaaa0004"]);
    expect((await jobs.check(look)).sort()).toEqual(["aaaa0002", "aaaa0005"]);
    expect(jobs.live("t1").map((j) => j.id)).toEqual(["aaaa0003"]);
    expect(jobs.unannounced().map((j) => [j.id, j.end.how, j.end.exitCode, j.end.at])).toEqual([
      ["aaaa0001", "finished", 0, 5_000], ["aaaa0002", "asleep", undefined, 9_000], ["aaaa0004", "failed", 2, 9_000], ["aaaa0005", "gone", undefined, 9_000],
    ]);
  });

  it("changes nothing at once when the computer is in any other state or cannot be asked, and a failed reading starts the count again", async () => {
    const jobs = new ComputerJobs(null);
    jobs.started(job());
    const gone = probe({ computer: async () => ({ state: "gone" }) });
    expect(await jobs.check(probe({ computer: async () => ({ state: "unsure" }) }))).toEqual([]);
    expect(await jobs.check(probe({ computer: async () => { throw new Error("network"); } }))).toEqual([]);
    expect(await jobs.check(gone)).toEqual([]);
    expect(await jobs.check(probe({ computer: async () => { throw new Error("network"); } }))).toEqual([]);
    expect(await jobs.check(gone)).toEqual([]);
    expect(await jobs.check(probe({ computer: async () => ({ state: "unsure" }) }))).toEqual([]);
    expect(await jobs.check(gone)).toEqual([]);
    expect(await jobs.check(probe({ computer: async () => ({ state: "asleep" }) }))).toEqual([]);
    expect(jobs.count("t1")).toBe(1);
  });

  const unreadable: Array<[string, ComputerJobProbe["computer"]]> = [
    ["in an error state, still starting or switched off", async () => ({ state: "unsure" })],
    ["unreachable", async () => { throw new Error("computers service unreachable"); }],
  ];
  for (const [label, computer] of unreadable) {
    it(`ends a job as lost, to be told once, after its computer has been ${label} for the set time`, async () => {
      let now = 1_000;
      const jobs = new ComputerJobs(null, { now: () => now });
      jobs.started(job());
      const look = probe({ computer });
      for (let waited = 0; waited < UNREADABLE_MS; waited += JOB_CHECK_MS) {
        expect(await jobs.check(look)).toEqual([]);
        now += JOB_CHECK_MS;
      }
      expect(jobs.count("t1")).toBe(1);
      expect(await jobs.check(look)).toEqual(["abcd1234"]);
      expect(jobs.count("t1")).toBe(0);
      expect(jobs.unannounced().map((j) => [j.id, j.end.how, j.end.at])).toEqual([["abcd1234", "lost", now]]);
    });
  }

  it("starts the unreadable time again once the computer can be read", async () => {
    let now = 1_000;
    const jobs = new ComputerJobs(null, { now: () => now });
    jobs.started(job());
    const lost = probe({ computer: async () => ({ state: "unsure" }) });
    expect(await jobs.check(lost)).toEqual([]);
    now += UNREADABLE_MS - 1;
    expect(await jobs.check(probe())).toEqual([]);
    now += 1;
    expect(await jobs.check(lost)).toEqual([]);
    now += UNREADABLE_MS - 1;
    expect(await jobs.check(lost)).toEqual([]);
    expect(jobs.count("t1")).toBe(1);
    now += 1;
    expect(await jobs.check(lost)).toEqual(["abcd1234"]);
  });

  it("waits longer than a cloud computer may take to start before calling it unreadable", () => {
    expect(UNREADABLE_MS).toBeGreaterThan(cloudComputerStartBudgetMs({}));
  });

  it("ends a job whose processes are gone without an exit record quietly, on two readings in a row", async () => {
    const jobs = new ComputerJobs(null, { now: () => 2_000 });
    jobs.started(job());
    const dead = probe({ liveness: async () => "dead" });
    expect(await jobs.check(dead)).toEqual([]);
    expect(await jobs.check(probe({ liveness: async () => "unsure" }))).toEqual([]);
    expect(await jobs.check(dead)).toEqual([]);
    expect(await jobs.check(dead)).toEqual(["abcd1234"]);
    expect(jobs.unannounced().map((j) => j.end.how)).toEqual(["lost"]);
  });

  it("stops a job once it has run for the longest a run may take, and ends it as stopped after that time", async () => {
    let now = 1_000;
    const jobs = new ComputerJobs(null, { now: () => now });
    jobs.started(job());
    const stopped: string[] = [];
    const look = probe({ stop: async (_box, j) => { stopped.push(j.id); return "gone"; } });
    now = 1_000 + MAX_RUN_MS;
    expect(await jobs.check(look)).toEqual(["abcd1234"]);
    expect(stopped).toEqual(["abcd1234"]);
    expect(jobs.count("t1")).toBe(0);
    expect(jobs.unannounced().map((j) => [j.id, j.end.how, j.end.stop, j.end.at])).toEqual([["abcd1234", "overdue", "gone", now]]);
  });

  it("leaves a job running, without stopping it, just under the longest a run may take", async () => {
    let now = 1_000;
    const jobs = new ComputerJobs(null, { now: () => now });
    jobs.started(job());
    const stopped: string[] = [];
    now = 1_000 + MAX_RUN_MS - 1;
    expect(await jobs.check(probe({ stop: async (_box, j) => { stopped.push(j.id); return "gone"; } }))).toEqual([]);
    expect(stopped).toEqual([]);
    expect(jobs.count("t1")).toBe(1);
    expect(jobs.unannounced()).toEqual([]);
  });

  it("ends a job that finished by then on its exit code, without stopping anything", async () => {
    let now = 1_000;
    const jobs = new ComputerJobs(null, { now: () => now });
    jobs.started(job());
    const stopped: string[] = [];
    now = 1_000 + MAX_RUN_MS + 60_000;
    expect(await jobs.check(probe({ exit: async () => ({ exitCode: 0 }), stop: async (_box, j) => { stopped.push(j.id); return "gone"; } }))).toEqual(["abcd1234"]);
    expect(stopped).toEqual([]);
    expect(jobs.unannounced().map((j) => [j.end.how, j.end.exitCode])).toEqual([["finished", 0]]);
  });

  it("ends a job past that time even when stopping it fails, keeps what the stop answered, and asks its computer nothing more about it", async () => {
    let now = 1_000;
    const jobs = new ComputerJobs(null, { now: () => now });
    jobs.started(job({ id: "aaaa0001" }));
    jobs.started(job({ id: "aaaa0002" }));
    jobs.started(job({ id: "aaaa0003" }));
    const asked: string[] = [];
    const look = probe({
      exit: async (_box, j) => { asked.push(`exit ${j.id}`); return null; },
      liveness: async (_box, j) => { asked.push(`liveness ${j.id}`); return "alive"; },
      stop: async (_box, j) => { asked.push(`stop ${j.id}`); if (j.id === "aaaa0001") throw new Error("exec timed out"); return j.id === "aaaa0003" ? "partial" : "alive"; },
    });
    now = 1_000 + MAX_RUN_MS;
    expect((await jobs.check(look)).sort()).toEqual(["aaaa0001", "aaaa0002", "aaaa0003"]);
    expect(jobs.unannounced().map((j) => [j.id, j.end.how, j.end.stop])).toEqual([["aaaa0001", "overdue", "alive"], ["aaaa0002", "overdue", "alive"], ["aaaa0003", "overdue", "partial"]]);
    asked.length = 0;
    now += JOB_CHECK_MS;
    expect(await jobs.check(look)).toEqual([]);
    expect(asked).toEqual([]);
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

  it("still reads a ledger written when a sleeping or missing computer was recorded as stopped", () => {
    const file = join(dir, "older.json");
    writeFileSync(file, JSON.stringify([{ ...job(), end: { how: "stopped", at: 5 } }]));
    expect(new ComputerJobs(file).unannounced().map((j) => j.end.how)).toEqual(["stopped"]);
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
