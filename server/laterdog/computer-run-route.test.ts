import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ComputerRuns, RunOutcome, RunRecord } from "./computer-runs.ts";
import { allowedFolder, handleComputerRun, outcomeText, repositoryFromRemote, repositoryOf } from "./computer-run-route.ts";

function home() {
  const root = mkdtempSync(join(tmpdir(), "run-route-"));
  for (const dir of ["site", ".laterdog/task-workspaces/dog/t1/repo", ".claude"]) mkdirSync(join(root, dir), { recursive: true });
  return root;
}

const outcome = (state: RunOutcome["state"], exitCode: number | null = 0): RunOutcome => ({ id: "abcd1234", state, exitCode, output: "ok", broughtBack: ["report.txt"], skipped: [], sentFiles: 2, sentBytes: 2048 });

function fakeRuns(result: RunOutcome, record: Partial<RunRecord> | null = null) {
  const calls: string[] = [];
  const runs = {
    record: () => record as RunRecord | null,
    run: async (_box: unknown, input: { restAfter?: boolean }) => { calls.push(`run rest=${Boolean(input.restAfter)}`); return result; },
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
  it("puts a computer that was asleep back to sleep once the run ends, and never while it is still going", async () => {
    const root = home();
    let rested = 0;
    const computer = async () => ({ box: {} as never, wasAsleep: true, rest: async () => { rested++; } });
    const done = fakeRuns(outcome("finished"));
    const answer = await handleComputerRun({ botId: "dog", body: { command: "pnpm test", folder: join(root, "site") }, workingFolder: null, allowedRoots: [], home: root }, { runs: done.runs, computer });
    expect(answer.status).toBe(200);
    expect(done.calls).toEqual(["run rest=true"]);
    expect(rested).toBe(1);
    const going = fakeRuns(outcome("running", null));
    await handleComputerRun({ botId: "dog", body: { command: "pnpm test", folder: join(root, "site") }, workingFolder: null, allowedRoots: [], home: root }, { runs: going.runs, computer });
    expect(rested).toBe(1);
  });

  it("finishes a run by its id, resting the computer only if the run began on a sleeping one", async () => {
    let rested = 0;
    const computer = async () => ({ box: {} as never, wasAsleep: false, rest: async () => { rested++; } });
    const later = fakeRuns(outcome("finished"), { id: "abcd1234", folder: "/x", restAfter: true });
    await handleComputerRun({ botId: "dog", body: { run_id: "abcd1234" }, workingFolder: null, allowedRoots: [] }, { runs: later.runs, computer });
    expect(later.calls).toEqual(["finish"]);
    expect(rested).toBe(1);
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
    const computer = async () => ({ box: {} as never, wasAsleep: false, rest: async () => undefined });
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
    const computer = async (_botId: string, options?: { repository?: string }) => { asked.push(options); return { box: {} as never, wasAsleep: false, rest: async () => undefined }; };
    await handleComputerRun({ botId: "dog", body: { command: "pnpm test", folder: site }, workingFolder: null, allowedRoots: [], home: root }, { runs: fakeRuns(outcome("finished")).runs, computer });
    const plain = join(root, "plain");
    mkdirSync(plain);
    await handleComputerRun({ botId: "dog", body: { command: "pnpm test", folder: plain }, workingFolder: null, allowedRoots: [], home: root }, { runs: fakeRuns(outcome("finished")).runs, computer, repositoryOf: () => null });
    expect(asked).toEqual([{ repository: "acme/site" }, {}]);
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
