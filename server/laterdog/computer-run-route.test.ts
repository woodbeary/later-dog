import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ComputerRuns, RunOutcome, RunRecord } from "./computer-runs.ts";
import { ComputerRuns as RealComputerRuns, WAIT_IN_ONE_CALL_MS, type RunBox } from "./computer-runs.ts";
import { ComputerJobs } from "./computer-jobs.ts";
import { STILL_STARTING_TEXT, WINDOW_ENDED_TEXT, allowedFolder, handleComputerRun, outcomeText, repositoryFromRemote, repositoryOf } from "./computer-run-route.ts";

function home() {
  const root = mkdtempSync(join(tmpdir(), "run-route-"));
  for (const dir of ["site", ".laterdog/task-workspaces/dog/t1/repo", ".claude"]) mkdirSync(join(root, dir), { recursive: true });
  return root;
}

const probeWith = (runs: ComputerRuns, box: RunBox) => ({
  computer: async () => ({ state: "running" as const, box }),
  exit: async (inner: RunBox, job: { botId: string; id: string }) => {
    const state = await runs.poll(inner, runs.record(job.botId, job.id)!);
    return state.done && state.exitCode !== null ? { exitCode: state.exitCode } : null;
  },
});

const outcome = (state: RunOutcome["state"], exitCode: number | null = 0): RunOutcome => ({ id: "abcd1234", state, exitCode, output: "ok", broughtBack: ["report.txt"], skipped: [], sentFiles: 2, sentBytes: 2048 });

function fakeRuns(result: RunOutcome, record: Partial<RunRecord> | null = null) {
  const calls: string[] = [];
  const runs = {
    record: () => record as RunRecord | null,
    run: async () => { calls.push("run"); return result; },
    finish: async () => { calls.push("finish"); return result; },
  } as unknown as ComputerRuns;
  return { runs, calls };
}

describe("which folder a dog may send", () => {
  it("allows its working folder, any folder under it, and the home's own project folders, never hidden ones", () => {
    const root = home();
    const work = join(root, ".laterdog/task-workspaces/dog/t1");
    const ask = (folder: string) => allowedFolder(folder, { workingFolder: work, allowedRoots: [work], home: root });
    expect(ask("")).toBe(work);
    expect(ask(join(work, "repo"))).toBe(join(work, "repo"));
    expect(ask(join(root, "site"))).toBe(join(root, "site"));
    expect(ask(join(root, ".claude"))).toBeNull();
    expect(ask(root)).toBeNull();
    expect(ask(join(root, "missing"))).toBeNull();
  });
});

describe("a run_on_computer call", () => {
  it("runs a command, and finishes a run by its id, including one recorded by an older home that asked to rest the computer", async () => {
    const root = home();
    const computer = async () => ({ box: {} as never });
    const done = fakeRuns(outcome("finished"));
    const answer = await handleComputerRun({ botId: "dog", body: { command: "pnpm test", folder: join(root, "site") }, workingFolder: null, allowedRoots: [], home: root }, { runs: done.runs, computer });
    expect(answer.status).toBe(200);
    expect(done.calls).toEqual(["run"]);
    const later = fakeRuns(outcome("finished"), { id: "abcd1234", folder: "/x", restAfter: true } as Partial<RunRecord>);
    expect((await handleComputerRun({ botId: "dog", body: { run_id: "abcd1234" }, workingFolder: null, allowedRoots: [] }, { runs: later.runs, computer })).status).toBe(200);
    expect(later.calls).toEqual(["finish"]);
  });

  it("refuses an unknown run, a missing command and a folder outside the home", async () => {
    const computer = async () => { throw new Error("not reached"); };
    const none = fakeRuns(outcome("finished"));
    expect((await handleComputerRun({ botId: "dog", body: { run_id: "ffff0000" }, workingFolder: null, allowedRoots: [] }, { runs: none.runs, computer })).status).toBe(404);
    expect((await handleComputerRun({ botId: "dog", body: {}, workingFolder: null, allowedRoots: [] }, { runs: none.runs, computer })).status).toBe(400);
    expect((await handleComputerRun({ botId: "dog", body: { command: "ls", folder: "/etc" }, workingFolder: null, allowedRoots: [], home: home() }, { runs: none.runs, computer })).status).toBe(400);
  });

  it("counts a command that ran and exited non-zero as a result, not a failed tool call", async () => {
    const root = home();
    const computer = async () => ({ box: {} as never });
    const failingTests = fakeRuns(outcome("finished", 1));
    const answer = await handleComputerRun({ botId: "dog", body: { command: "pnpm test", folder: join(root, "site") }, workingFolder: null, allowedRoots: [], home: root }, { runs: failingTests.runs, computer });
    expect(answer.failed).toBe(false);
    expect(answer.text).toContain("exit code 1");
  });

  it("asks for the computer with the repository a folder is cloned from, so a new computer can start from its environment", async () => {
    const root = home();
    const site = join(root, "site");
    spawnSync("git", ["init", "-q", site]);
    spawnSync("git", ["-C", site, "remote", "add", "origin", "https://github.com/acme/site.git"]);
    expect(repositoryOf(site)).toBe("acme/site");
    expect(repositoryOf(join(root, ".claude"))).toBeNull();
    const asked: unknown[] = [];
    const computer = async (_botId: string, options?: { repository?: string }) => { asked.push(options); return { box: {} as never }; };
    await handleComputerRun({ botId: "dog", body: { command: "pnpm test", folder: site }, workingFolder: null, allowedRoots: [], home: root }, { runs: fakeRuns(outcome("finished")).runs, computer });
    const plain = join(root, "plain");
    mkdirSync(plain);
    await handleComputerRun({ botId: "dog", body: { command: "pnpm test", folder: plain }, workingFolder: null, allowedRoots: [], home: root }, { runs: fakeRuns(outcome("finished")).runs, computer, repositoryOf: () => null });
    expect(asked).toEqual([{ repository: "acme/site", budgetMs: WAIT_IN_ONE_CALL_MS }, { budgetMs: WAIT_IN_ONE_CALL_MS }]);
  });

  it("reads only a GitHub owner/name out of a remote, never its credentials", () => {
    expect(repositoryFromRemote("https://github.com/acme/site.git\n")).toBe("acme/site");
    expect(repositoryFromRemote("https://x-access-token:secret@github.com/acme/site")).toBe("acme/site");
    expect(repositoryFromRemote("git@github.com:acme/site.js.git")).toBe("acme/site.js");
    expect(repositoryFromRemote("ssh://git@github.com/acme/site/")).toBe("acme/site");
    for (const remote of ["https://gitlab.com/acme/site.git", "https://github.com/acme", "https://github.com/acme/site/tree/main", "https://github.com/acme/..", "/srv/git/site.git"]) {
      expect(repositoryFromRemote(remote)).toBeNull();
    }
  });

  it("tells the dog what ran, what came back and the end of the output", () => {
    expect(outcomeText(outcome("finished"))).toBe("Finished on your cloud computer with exit code 0 (run_id abcd1234).\nSent 2 changed file(s), 2 KB.\nBrought back 1 file(s): report.txt.\n\nOutput (end):\nok");
  });
});

describe("starting the computer inside one run_on_computer call", () => {
  const ask = (root: string, active?: () => boolean) => ({ botId: "dog", body: { command: "pnpm test", folder: join(root, "site") }, workingFolder: null, allowedRoots: [], home: root, ...(active ? { active } : {}) });

  it("never runs the command once the turn that asked has ended during startup", async () => {
    const root = home();
    let active = true;
    const asked: Array<{ wanted?: () => boolean }> = [];
    const computer = async (_botId: string, options?: { wanted?: () => boolean }) => { asked.push(options ?? {}); active = false; return { box: {} as never }; };
    const runs = fakeRuns(outcome("finished"));
    const answer = await handleComputerRun(ask(root, () => active), { runs: runs.runs, computer });
    expect(answer.status).toBe(409);
    expect(runs.calls).toEqual([]);
    expect(asked[0].wanted?.()).toBe(false);
  });

  it("answers that the computer is still starting, without running anything, when one call's window ends", async () => {
    const root = home();
    const computer = async () => { throw Object.assign(new Error("still starting"), { code: "still_starting" }); };
    const runs = fakeRuns(outcome("finished"));
    const answer = await handleComputerRun(ask(root), { runs: runs.runs, computer });
    expect(answer).toEqual({ status: 200, text: STILL_STARTING_TEXT });
    expect(runs.calls).toEqual([]);
  });

  it.each([[0, WAIT_IN_ONE_CALL_MS], [200_000, WAIT_IN_ONE_CALL_MS - 200_000], [239_000, 1_000]])("after %i ms of startup, leaves %i ms of the call's window for sending and the command", async (startupMs, waitMs) => {
    const root = home();
    let at = 1_000_000;
    const waits: unknown[] = [];
    const runs = { record: () => null, run: async (_box: unknown, input: { left: () => number }) => { waits.push(input.left()); return outcome("finished"); }, finish: async () => outcome("finished") } as unknown as ComputerRuns;
    const computer = async () => { at += startupMs; return { box: {} as never }; };
    await handleComputerRun(ask(root), { runs, computer, now: () => at });
    expect(waits).toEqual([waitMs]);
  });
});

describe("one run_on_computer call with the real run store", () => {
  function fakeBox(options: { onWrite?: () => Promise<void> | void; onPoll?: () => void; exitCode?: number } = {}) {
    const execs: Array<{ command: string; timeoutMs: number }> = [];
    const box: RunBox = {
      async exec(command, timeoutMs) {
        execs.push({ command, timeoutMs });
        if (command.startsWith("test -d")) return { exitCode: 0, stdout: "no\n", stderr: "" };
        if (command.startsWith("cat runs/.logs/")) options.onPoll?.();
        if (command.startsWith("cat runs/.logs/")) return { exitCode: 0, stdout: options.exitCode === undefined ? "<<<\n" : `${options.exitCode}\n<<<\nok`, stderr: "" };
        if (command.includes("nohup")) return { exitCode: 0, stdout: "started\n", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async write() { await options.onWrite?.(); },
      async read() { return Buffer.alloc(0); },
    };
    return { box, execs };
  }
  function setup() {
    const root = home();
    writeFileSync(join(root, "site/page.ts"), "export const page = 1;\n");
    const clock = { at: 1_000_000, slept: 0 };
    const runs = new RealComputerRuns(join(root, "state"), { now: () => clock.at, sleep: async (ms) => { clock.at += ms; clock.slept += ms; } });
    return { root, clock, runs, ask: (active?: () => boolean) => ({ botId: "dog", body: { command: "pnpm test", folder: join(root, "site") } as Record<string, unknown>, workingFolder: null, allowedRoots: [], home: root, ...(active ? { active } : {}) }) };
  }
  const launched = (execs: Array<{ command: string }>) => execs.filter((exec) => exec.command.includes("nohup")).length;

  it("counts a 70 s transfer after a 60 s wake against the same window, leaving 110 s for the command", async () => {
    const { clock, runs, ask } = setup();
    const { box, execs } = fakeBox({ onWrite: () => { clock.at += 70_000; } });
    const computer = async () => { clock.at += 60_000; return { box }; };
    const answer = await handleComputerRun(ask(), { runs, computer, now: () => clock.at });
    expect(answer.text).toContain("Still running");
    expect(launched(execs)).toBe(1);
    expect(clock.slept).toBe(110_000);
    expect(clock.at - 1_000_000).toBe(WAIT_IN_ONE_CALL_MS);
    expect(Math.max(...execs.filter((exec) => exec.command.startsWith("cat runs/.logs/")).map((exec) => exec.timeoutMs))).toBeLessThanOrEqual(30_000);
  });

  it("never launches the command when the turn ends while the folder is still uploading", async () => {
    const { root, runs, ask } = setup();
    let active = true;
    let release = () => {};
    let writing = false;
    const { box, execs } = fakeBox({ onWrite: () => { writing = true; return new Promise<void>((done) => { release = done; }); } });
    const computer = async () => ({ box });
    const pending = handleComputerRun(ask(() => active), { runs, computer });
    while (!writing) await new Promise((done) => setImmediate(done));
    active = false;
    release();
    const answer = await pending;
    expect(answer.status).toBe(409);
    expect(answer.text).toBeUndefined();
    expect(launched(execs)).toBe(0);
    expect(readdirSync(join(root, "state/dog")).filter((name) => name.startsWith("run-"))).toEqual([]);
  });

  it("never launches the command once sending the folder used up the call's window, and keeps what was sent", async () => {
    const { root, clock, runs, ask } = setup();
    const { box, execs } = fakeBox({ onWrite: () => { clock.at += 500_000; } });
    const computer = async () => ({ box });
    const answer = await handleComputerRun(ask(() => true), { runs, computer, now: () => clock.at });
    expect(answer).toEqual({ status: 200, text: WINDOW_ENDED_TEXT });
    expect(launched(execs)).toBe(0);
    expect(readdirSync(join(root, "state/dog")).filter((name) => name.startsWith("run-"))).toEqual([]);
    expect(readdirSync(join(root, "state/dog")).filter((name) => name.endsWith(".sent.json"))).toHaveLength(1);
  });

  it("leaves a finished run's files for the next call when the window is used up, then brings them back by run_id", async () => {
    const { clock, runs, ask } = setup();
    let polled = false;
    const { box, execs } = fakeBox({ exitCode: 0, onPoll: () => { if (!polled) clock.at += WAIT_IN_ONE_CALL_MS; polled = true; } });
    const computer = async () => ({ box });
    const first = await handleComputerRun(ask(), { runs, computer, now: () => clock.at });
    expect(first.text).toMatch(/^Finished on your cloud computer with exit code 0 \(run_id [0-9a-f]{8}\); its files are still there\./);
    expect(execs.some((exec) => exec.command.includes("python3 -c"))).toBe(false);
    const runId = /run_id ([0-9a-f]{8})/.exec(first.text!)![1];
    const second = await handleComputerRun({ ...ask(), body: { run_id: runId } }, { runs, computer, now: () => clock.at });
    expect(second.text).toContain("Finished on your cloud computer with exit code 0");
    expect(second.text).not.toContain("still there");
    expect(execs.some((exec) => exec.command.includes("python3 -c"))).toBe(true);
  });

  it("keeps a run that outlives its call counted for its chat until a later call brings it back", async () => {
    const { clock, runs, ask } = setup();
    const jobs = new ComputerJobs(null, { now: () => clock.at });
    const going = fakeBox();
    const first = await handleComputerRun({ ...ask(), threadId: "t1" }, { runs, jobs, computer: async () => ({ box: going.box }), now: () => clock.at });
    expect(first.text).toContain("Still running");
    const runId = /run_id ([0-9a-f]{8})/.exec(first.text!)![1];
    expect(jobs.live("t1").map((job) => [job.id, job.botId, job.command])).toEqual([[runId, "dog", "pnpm test"]]);
    expect(await jobs.check(probeWith(runs, going.box))).toEqual([]);
    expect(jobs.count("t1")).toBe(1);
    const finished = fakeBox({ exitCode: 0 });
    const second = await handleComputerRun({ ...ask(), body: { run_id: runId }, threadId: "t1" }, { runs, jobs, computer: async () => ({ box: finished.box }), now: () => clock.at });
    expect(second.text).toContain("Finished on your cloud computer with exit code 0");
    expect(jobs.count("t1")).toBe(0);
  });

  it("ends a job that finished while nobody waited on it, leaving its files for the next call", async () => {
    const { clock, runs, ask } = setup();
    const jobs = new ComputerJobs(null, { now: () => clock.at });
    const first = await handleComputerRun({ ...ask(), threadId: "t1" }, { runs, jobs, computer: async () => ({ box: fakeBox().box }), now: () => clock.at });
    const runId = /run_id ([0-9a-f]{8})/.exec(first.text!)![1];
    const finished = fakeBox({ exitCode: 0 });
    expect(await jobs.check(probeWith(runs, finished.box))).toEqual([runId]);
    expect(jobs.count("t1")).toBe(0);
    expect(jobs.unannounced().map((job) => [job.id, job.end.how])).toEqual([[runId, "finished"]]);
    const read = await handleComputerRun({ ...ask(), body: { run_id: runId }, threadId: "t1" }, { runs, jobs, computer: async () => ({ box: finished.box }), now: () => clock.at });
    expect(read.text).toContain("Finished on your cloud computer with exit code 0");
    expect(jobs.unannounced()).toEqual([]);
  });

  it("lets another call on the same computer finish when an overlapping call is abandoned", async () => {
    const { runs, ask } = setup();
    let activeA = true;
    let releaseB = () => {};
    const { box } = fakeBox({ exitCode: 0 });
    let writingB = false;
    const blocked: RunBox = { ...box, write: () => { writingB = true; return new Promise<void>((done) => { releaseB = done; }); } };
    let wake = () => {};
    const woke = new Promise<void>((done) => { wake = done; });
    const computerA = async () => { await woke; activeA = false; return { box }; };
    const computerB = async () => ({ box: blocked });
    const a = handleComputerRun(ask(() => activeA), { runs, computer: computerA });
    const b = handleComputerRun(ask(), { runs, computer: computerB });
    while (!writingB) await new Promise((done) => setImmediate(done));
    wake();
    expect((await a).status).toBe(409);
    releaseB();
    const answer = await b;
    expect(answer.status).toBe(200);
    expect(answer.text).toContain("Finished on your cloud computer with exit code 0");
  });
});
