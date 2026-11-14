import { describe, expect, it } from "vitest";
import type { WireMessage } from "../../shared/wire.ts";
import { ComputerJobs, type ComputerJob } from "./computer-jobs.ts";
import { MAX_RUN_MS } from "./computer-runs.ts";
import { createJobWake, jobWakeLine, jobWakePrompt, WAKE_FRESH_MS, type JobWakeHost } from "./job-wake.ts";

const NOW = 10_000_000_000;
const job = (id: string, threadId = "t1", startedAt = NOW - 60_000): ComputerJob => ({ id, botId: "scout", threadId, command: "pnpm test", startedAt });
const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
const end = (how: "finished" | "failed" | "stopped" = "finished", at = NOW - 1_000) => ({ how, ...(how === "stopped" ? {} : { exitCode: how === "finished" ? 0 : 1 }), at });

function setup(over: Partial<JobWakeHost> = {}) {
  const jobs = new ComputerJobs(null);
  const path: WireMessage[] = [{ id: "user-1", role: "user", kind: "text", text: "Build it", at: "" } as unknown as WireMessage];
  const turns: Array<{ threadId: string; prompt: string; request: string }> = [];
  let free = true;
  let handoffDone = false;
  const host: JobWakeHost = {
    dog: (threadId) => (threadId.startsWith("room") ? null : { botId: "scout", name: "Scout" }),
    free: () => free,
    path: () => path,
    handoffDone: () => handoffDone,
    request: () => "user-1",
    append: (_threadId, message) => { const row = { ...message, id: `m${path.length}`, at: "" } as unknown as WireMessage; path.push(row); return row; },
    start: async (_botId, threadId, prompt, request) => { turns.push({ threadId, prompt, request }); },
    blocked: () => false,
    now: () => NOW,
    ...over,
  };
  const lines = () => path.filter((row) => row.tool?.pickup === "computer").map((row) => row.tool!.name);
  return { jobs, path, lines, turns, wake: createJobWake(jobs, host), busy: (value: boolean) => { free = !value; }, handoff: (value: boolean) => { handoffDone = value; } };
}

const ended = (jobs: ComputerJobs, id: string, how: "finished" | "failed" | "stopped" = "finished", threadId = "t1", at = NOW - 1_000, startedAt?: number) => {
  jobs.started(job(id, threadId, startedAt));
  jobs.finished(id, end(how, at));
};

describe("waking a dog when a job on its computer ends", () => {
  it("starts one turn with a note saying how it ended and which run id to read, then writes the line", async () => {
    const { jobs, lines, turns, wake } = setup();
    ended(jobs, "aaaa0001", "failed");
    expect(wake.deliver()).toEqual(["t1"]);
    await flush();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toContain("failed with exit code 1");
    expect(turns[0]!.prompt).toContain('run_id "aaaa0001"');
    expect(turns[0]!.prompt).toContain("not typed by the person");
    expect(turns[0]!.request).toBe("user-1");
    expect(lines()).toEqual(["recovery: Scout's command failed, so it is carrying on."]);
  });

  it("writes no line and keeps the ending until the turn has really started", async () => {
    let release: () => void = () => {};
    const { jobs, lines, wake } = setup({ start: () => new Promise<void>((resolve) => { release = resolve; }) });
    ended(jobs, "aaaa0001");
    wake.deliver();
    await flush();
    expect(lines()).toEqual([]);
    expect(jobs.unannounced()).toHaveLength(1);
    expect(wake.deliver()).toEqual([]);
    release();
    await flush();
    expect(lines()).toHaveLength(1);
    expect(jobs.unannounced()).toEqual([]);
  });

  it("wakes once per job, ever", async () => {
    const { jobs, turns, wake } = setup();
    ended(jobs, "aaaa0001");
    wake.deliver(); await flush();
    expect(wake.deliver()).toEqual([]);
    expect(turns).toHaveLength(1);
  });

  it("wakes at most twice per message from the person, then says once that it did not wake the dog", async () => {
    const { jobs, lines, turns, wake, path } = setup();
    for (let index = 1; index <= 5; index += 1) {
      ended(jobs, `c000000${index}`);
      wake.deliver(); await flush();
    }
    expect(turns).toHaveLength(2);
    expect(lines().filter((line) => line.startsWith("recovery:"))).toHaveLength(2);
    expect(lines().filter((line) => line === "Scout's command finished. Scout was not woken for it.")).toHaveLength(3);
    path.push({ id: "user-2", role: "user", kind: "text", text: "Again", at: "" } as unknown as WireMessage);
    ended(jobs, "c0000006");
    wake.deliver(); await flush();
    expect(turns).toHaveLength(3);
  });

  it("does not wake for an ending older than 30 minutes, and says so", async () => {
    const { jobs, lines, turns, wake, busy } = setup();
    ended(jobs, "aaaa0001", "finished", "t1", NOW - WAKE_FRESH_MS - 1);
    busy(true);
    wake.deliver(); await flush();
    expect(turns).toEqual([]);
    expect(lines()).toEqual(["Scout's command finished. Scout was not woken for it."]);
    expect(jobs.unannounced()).toEqual([]);
  });

  it("does not wake for a job that ran longer than a run may take", async () => {
    const { jobs, lines, turns, wake } = setup();
    ended(jobs, "aaaa0001", "finished", "t1", NOW - 1_000, NOW - 1_000 - MAX_RUN_MS - 1);
    wake.deliver(); await flush();
    expect(turns).toEqual([]);
    expect(lines()).toEqual(["Scout's command finished. Scout was not woken for it."]);
  });

  it("does not wake a chat whose work for another dog is already done", async () => {
    const { jobs, lines, turns, wake, handoff } = setup();
    handoff(true);
    ended(jobs, "aaaa0001");
    wake.deliver(); await flush();
    expect(turns).toEqual([]);
    expect(lines()).toEqual(["Scout's command finished. Scout was not woken for it."]);
  });

  it("makes one turn for several jobs ending close together", async () => {
    const { jobs, turns, lines, wake } = setup();
    ended(jobs, "aaaa0001");
    ended(jobs, "aaaa0002");
    wake.deliver(); await flush();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toContain('"aaaa0001"');
    expect(turns[0]!.prompt).toContain('"aaaa0002"');
    expect(lines()).toEqual(["recovery: Scout's 2 commands ended, so it is carrying on."]);
  });

  it("waits while the chat is not free, and never drops a fresh ending", async () => {
    const { jobs, turns, wake, busy } = setup();
    ended(jobs, "aaaa0001", "stopped");
    busy(true);
    expect(wake.deliver()).toEqual([]);
    expect(jobs.unannounced()).toHaveLength(1);
    busy(false);
    expect(wake.deliver()).toEqual(["t1"]);
    await flush();
    expect(turns[0]!.prompt).toContain("was stopped before it could finish");
  });

  it("keeps the ending when the account cannot take the turn yet, with no line until it starts", async () => {
    let refuse = true;
    const { jobs, lines, turns, wake } = setup({
      start: async (_botId, threadId, prompt, request) => { if (refuse) throw new Error("blocked"); turns.push({ threadId, prompt, request }); },
      blocked: () => true,
    });
    ended(jobs, "aaaa0001");
    wake.deliver(); await flush();
    expect(jobs.unannounced()).toHaveLength(1);
    expect(lines()).toEqual([]);
    refuse = false;
    wake.deliver(); await flush();
    expect(turns).toHaveLength(1);
    expect(lines()).toHaveLength(1);
    expect(jobs.unannounced()).toEqual([]);
  });

  it("says when the turn could not start for any other reason", async () => {
    const { jobs, lines, wake } = setup({ start: async () => { throw new Error("engine missing"); } });
    ended(jobs, "aaaa0001");
    wake.deliver(); await flush();
    expect(jobs.unannounced()).toEqual([]);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain("could not carry on");
  });

  it("nothing for a job the dog read itself or one the person stopped", () => {
    const { jobs, turns, wake } = setup();
    ended(jobs, "aaaa0001");
    jobs.ended("aaaa0001");
    jobs.started(job("aaaa0002"));
    jobs.quiet("t1");
    jobs.finished("aaaa0002", end());
    expect(wake.deliver()).toEqual([]);
    expect(turns).toEqual([]);
  });

  it("does not wake a group chat's dog, and does not keep the ending", () => {
    const { jobs, turns, wake } = setup();
    ended(jobs, "aaaa0001", "finished", "room-thread");
    expect(wake.deliver()).toEqual([]);
    expect(turns).toEqual([]);
    expect(jobs.unannounced()).toEqual([]);
  });

  it("says once, without waking, that a job ended without a result", async () => {
    const { jobs, lines, turns, wake } = setup();
    jobs.started(job("aaaa0001"));
    jobs.finished("aaaa0001", { how: "lost", at: NOW - 1_000 });
    wake.deliver(); await flush();
    expect(turns).toEqual([]);
    expect(lines()).toEqual(["Scout's command on its computer ended without a result."]);
    expect(jobs.unannounced()).toEqual([]);
  });

  it("counts wake-ups from the person's own last message, not from a teammate, routine or webhook line", async () => {
    const { jobs, turns, wake, path } = setup();
    ended(jobs, "c0000001"); wake.deliver(); await flush();
    path.push({ id: "mate", role: "user", kind: "text", text: "From a teammate", from: { botId: "b", name: "Biscuit", color: "x" }, at: 0 } as unknown as WireMessage);
    path.push({ id: "hook", role: "user", kind: "text", text: "Webhook", webhookPost: true, at: 0 } as unknown as WireMessage);
    ended(jobs, "c0000002"); wake.deliver(); await flush();
    ended(jobs, "c0000003"); wake.deliver(); await flush();
    expect(turns).toHaveLength(2);
  });

  it("words", () => {
    const one = { ...job("aaaa0001"), end: { how: "finished" as const, exitCode: 0, at: 5 } };
    expect(jobWakeLine("Scout", [one])).toBe("Scout's command finished, so it is carrying on.");
    expect(jobWakePrompt([one])).toContain("`pnpm test` finished with exit code 0");
  });
});
