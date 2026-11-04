import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ComputerRuns, RunOutcome, RunRecord } from "./computer-runs.ts";
import { allowedFolder, handleComputerRun, outcomeText } from "./computer-run-route.ts";

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

  it("tells the dog what ran, what came back and the end of the output", () => {
    expect(outcomeText(outcome("finished"))).toBe("Finished on your cloud computer with exit code 0 (run_id abcd1234).\nSent 2 changed file(s), 2 KB.\nBrought back 1 file(s): report.txt.\n\nOutput (end):\nok");
  });
});
