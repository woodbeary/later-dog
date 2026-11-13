import { describe, expect, it } from "vitest";
import type { WireMessage } from "../../shared/wire.ts";
import { ComputerJobs, type ComputerJob } from "./computer-jobs.ts";
import { createJobWake, jobWakeLine, jobWakePrompt, type JobWakeHost } from "./job-wake.ts";

const job = (id: string, threadId = "t1"): ComputerJob => ({ id, botId: "scout", threadId, command: "pnpm test", startedAt: 1 });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(over: Partial<JobWakeHost> = {}) {
  const jobs = new ComputerJobs(null);
  const lines: Array<{ threadId: string; message: Omit<WireMessage, "id" | "at"> }> = [];
  const turns: Array<{ threadId: string; prompt: string; request: string }> = [];
  let free = true;
  const host: JobWakeHost = {
    dog: (threadId) => (threadId.startsWith("room") ? null : { botId: "scout", name: "Scout" }),
    free: () => free,
    request: () => "user-1",
    append: (threadId, message) => { lines.push({ threadId, message }); return { ...message, id: `m${lines.length}`, at: "" } as unknown as WireMessage; },
    start: async (_botId, threadId, prompt, request) => { turns.push({ threadId, prompt, request }); },
    blocked: () => false,
    ...over,
  };
  return { jobs, lines, turns, wake: createJobWake(jobs, host), busy: (value: boolean) => { free = !value; } };
}

describe("waking a dog when a job on its computer ends", () => {
  it("starts one turn with a note saying how it ended and which run id to read, and a line for the person", async () => {
    const { jobs, lines, turns, wake } = setup();
    jobs.started(job("aaaa0001"));
    jobs.finished("aaaa0001", { how: "failed", exitCode: 1, at: 5 });
    expect(wake.deliver()).toEqual(["t1"]);
    await flush();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toContain("failed with exit code 1");
    expect(turns[0]!.prompt).toContain('run_id "aaaa0001"');
    expect(turns[0]!.prompt).toContain("not typed by the person");
    expect(turns[0]!.request).toBe("user-1");
    expect(lines.map((line) => line.message.tool)).toEqual([{ name: "recovery: Scout's command failed, so it is carrying on.", ok: true, pickup: "computer" }]);
  });

  it("wakes once per job, ever", async () => {
    const { jobs, turns, wake } = setup();
    jobs.started(job("aaaa0001"));
    jobs.finished("aaaa0001", { how: "finished", exitCode: 0, at: 5 });
    wake.deliver(); await flush();
    expect(wake.deliver()).toEqual([]);
    expect(turns).toHaveLength(1);
  });

  it("makes one turn for several jobs ending close together", async () => {
    const { jobs, turns, lines, wake } = setup();
    for (const id of ["aaaa0001", "aaaa0002"]) { jobs.started(job(id)); jobs.finished(id, { how: "finished", exitCode: 0, at: 5 }); }
    wake.deliver(); await flush();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toContain('"aaaa0001"');
    expect(turns[0]!.prompt).toContain('"aaaa0002"');
    expect(lines[0]!.message.tool?.name).toBe("recovery: Scout's 2 commands ended, so it is carrying on.");
  });

  it("waits while the chat is busy, held for usage or asking, and never drops the ending", async () => {
    const { jobs, turns, wake, busy } = setup();
    jobs.started(job("aaaa0001"));
    jobs.finished("aaaa0001", { how: "stopped", at: 5 });
    busy(true);
    expect(wake.deliver()).toEqual([]);
    expect(jobs.unannounced()).toHaveLength(1);
    busy(false);
    expect(wake.deliver()).toEqual(["t1"]);
    await flush();
    expect(turns[0]!.prompt).toContain("was stopped before it could finish");
  });

  it("keeps the ending when the account cannot take the turn yet, and shows its line once", async () => {
    let refuse = true;
    const { jobs, lines, turns, wake } = setup({
      start: async (_botId, threadId, prompt, request) => { if (refuse) throw new Error("blocked"); turns.push({ threadId, prompt, request }); },
      blocked: () => true,
    });
    jobs.started(job("aaaa0001"));
    jobs.finished("aaaa0001", { how: "finished", exitCode: 0, at: 5 });
    wake.deliver(); await flush(); await flush();
    expect(jobs.unannounced()).toHaveLength(1);
    refuse = false;
    wake.deliver(); await flush();
    expect(turns).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(jobs.unannounced()).toEqual([]);
  });

  it("nothing for a job the dog read itself or one the person's Stop ended", () => {
    const { jobs, turns, wake } = setup();
    jobs.started(job("aaaa0001"));
    jobs.finished("aaaa0001", { how: "finished", exitCode: 0, at: 5 });
    jobs.ended("aaaa0001");
    jobs.started(job("aaaa0002"));
    jobs.quiet("t1");
    expect(wake.deliver()).toEqual([]);
    expect(turns).toEqual([]);
  });

  it("does not wake a group chat's dog, and does not keep the ending", () => {
    const { jobs, turns, wake } = setup();
    jobs.started(job("aaaa0001", "room-thread"));
    jobs.finished("aaaa0001", { how: "finished", exitCode: 0, at: 5 });
    expect(wake.deliver()).toEqual([]);
    expect(turns).toEqual([]);
    expect(jobs.unannounced()).toEqual([]);
  });

  it("words", () => {
    const ended = { ...job("aaaa0001"), end: { how: "finished" as const, exitCode: 0, at: 5 } };
    expect(jobWakeLine("Scout", [ended])).toBe("Scout's command finished, so it is carrying on.");
    expect(jobWakePrompt([ended])).toContain("`pnpm test` finished with exit code 0");
  });
});
