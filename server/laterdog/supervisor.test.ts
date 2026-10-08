import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createJobSchema, repositorySchema, scopesOverlap, type Job, type Repository } from "../../shared/laterdog.ts";
import { WorkspaceStore } from "./store.ts";
import { Supervisor, correctionTitle } from "./supervisor.ts";
import { CODEX_CLOUD_CAPABILITIES, SubmissionUnknown, type ExecutionAdapter } from "./codex-cloud.ts";
import { CLAUDE_CLOUD_CAPABILITIES } from "./claude-cloud.ts";
import { GitHubPublisher } from "./github.ts";
import { BridgeStore } from "./bridge-store.ts";
import { deliverOutbox } from "./notifications.ts";

const SHA = "a".repeat(40); const NEW_SHA = "b".repeat(40);
const dirs: string[] = []; const stores: WorkspaceStore[] = []; const supervisors: Supervisor[] = [];
afterEach(() => { supervisors.splice(0).forEach((s) => s.stop()); stores.splice(0).forEach((s) => s.close()); dirs.splice(0).forEach((d) => rmSync(d,{ recursive: true, force: true })); });
function fixture(options: { concurrency?: number; file?: boolean; remote?: boolean; adapter?: ExecutionAdapter } = {}) {
  const dir = mkdtempSync(join(tmpdir(),"laterdog-test-")); dirs.push(dir);
  const store = new WorkspaceStore(options.file ? join(dir,"workspace.sqlite") : ":memory:"); stores.push(store);
  store.saveRepository(repositorySchema.parse({ slug: "fixture/first", environmentId: "test-environment" }));
  store.saveRepository(repositorySchema.parse({ slug: "fixture/second", environmentId: "test-environment" }));
  const submit = vi.fn(async () => ({ taskId: `task_${randomUUID()}`, taskUrl: "https://chatgpt.com/codex/tasks/fixture" }));
  const inspect = vi.fn(async (): Promise<"running" | "ready" | "failed"> => "running");
  const collect = vi.fn(async () => "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n");
  const adapter: ExecutionAdapter = options.adapter ?? { capabilities: CODEX_CLOUD_CAPABILITIES, submit, inspect, collect, list: async () => ({ tasks: [] }) };
  const publisher = new GitHubPublisher(join(dir,"checkouts"));
  vi.spyOn(publisher,"prepare").mockImplementation(async (job) => ({ baseSha: SHA, sourceRef: `laterdog/input/${job.id}` }));
  vi.spyOn(publisher,"inspectPublished").mockImplementation(async job => ({headSha:job.headSha ?? SHA,state:"OPEN"}));
  vi.spyOn(publisher,"publish").mockResolvedValue({ headSha: SHA, prUrl: "https://github.com/fixture/first/pull/1", prNumber: 1 });
  const supervisor = new Supervisor(store,{ dataDir: dir, profiles: [{ id: "default", label: "Fixture account" }], concurrency: options.concurrency ?? 4, publishingHost: options.remote ? "remote" : "local", adapter: () => adapter, publisher }); supervisors.push(supervisor);
  const create = (overrides: Record<string,unknown> = {}) => supervisor.create({ requestKey: randomUUID(),repository: "fixture/first",title: "Fixture change",brief: "Prove the change",writeScopes: ["src/a.ts"],...overrides });
  return { dir,store,supervisor,adapter,publisher,submit,inspect,collect,create };
}
describe("durable cloud orchestration",() => {
  it("deduplicates the same request and rejects key reuse for different work",() => {
    const f = fixture(); const input = { requestKey: randomUUID(),repository: "fixture/first",title: "One task",brief: "One change" };
    expect(f.supervisor.create(input).id).toBe(f.supervisor.create(input).id);
    expect(() => f.supervisor.create({ ...input,brief: "Different scope" })).toThrow(/different request/);
    expect(f.store.jobs()).toHaveLength(1);
  });
  it("runs independent changes across two repositories and serializes conflicting writers",async () => {
    const f = fixture(); const first = f.create(); const second = f.create({ writeScopes: ["src/b.ts"] });
    const third = f.create({ repository: "fixture/second" }); const conflict = f.create({ writeScopes: ["src"] });
    await f.supervisor.tick(); expect(f.submit).toHaveBeenCalledTimes(3);
    for (const j of [first,second,third]) expect(f.store.job(j.id).state).toBe("running");
    expect(f.store.job(conflict.id).state).toBe("queued");
    expect(new Set([first,second,third].map((j) => f.store.job(j.id).sourceRef)).size).toBe(3);
  });
  it("counts review and repair runs toward the global concurrency cap",async () => {
    const f = fixture({ concurrency: 2 }); f.create(); f.create({ repository: "fixture/second",kind: "review" });
    const third = f.create({ writeScopes: ["src/c.ts"],kind: "repair" }); await f.supervisor.tick();
    expect(f.submit).toHaveBeenCalledTimes(2); expect(f.store.job(third.id).state).toBe("queued"); expect(f.supervisor.snapshot().active).toBe(2);
  });
  it("never resubmits an uncertain submission",async () => {
    const f = fixture(); f.submit.mockRejectedValue(new SubmissionUnknown()); const job = f.create();
    await f.supervisor.tick(); await f.supervisor.tick(); expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.store.job(job.id).state).toBe("submission_unknown");
    await f.supervisor.reconcile(job.id,"task_known"); await f.supervisor.tick(); expect(f.submit).toHaveBeenCalledTimes(1); expect(f.store.job(job.id).taskId).toBe("task_known");
  });
  it("releases an uncertain submission's slot only when the operator acknowledges that no provider task exists",async () => {
    const f = fixture({ concurrency: 1 }); f.submit.mockRejectedValue(new SubmissionUnknown()); const job = f.create(); await f.supervisor.tick();
    expect(f.store.job(job.id).state).toBe("submission_unknown"); expect(f.supervisor.snapshot().active).toBe(1);
    expect(() => f.supervisor.cancel(job.id)).toThrow(/uncertain/); expect(f.store.job(job.id).state).toBe("submission_unknown");
    expect(f.supervisor.cancel(job.id,true).state).toBe("cancelled"); expect(f.supervisor.snapshot().active).toBe(0);
    f.submit.mockResolvedValue({ taskId: "task_next", taskUrl: "https://chatgpt.com/codex/tasks/task_next" }); const next = f.create({ writeScopes: ["src/b.ts"] }); await f.supervisor.tick();
    expect(f.store.job(next.id).state).toBe("running");
  });
  it("recovers persisted task IDs after a controller restart",async () => {
    const f = fixture({ file: true }); const job = f.create(); await f.supervisor.tick(); f.supervisor.stop(); await f.supervisor.drain();
    const next = new Supervisor(f.store,{ ...f.supervisor.options }); supervisors.push(next); await next.tick();
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.inspect).toHaveBeenCalled(); expect(f.store.job(job.id).state).toBe("running");
  });
  it("marks a crash during submission uncertain instead of replaying it",async () => {
    const f = fixture(); const job = f.create(); f.store.update(job.id,{ state: "submitting" }); await f.supervisor.tick();
    expect(f.submit).not.toHaveBeenCalled(); expect(f.store.job(job.id).state).toBe("submission_unknown");
  });
  it("collects a provider diff durably without claiming verification",async () => {
    const f = fixture(); const job = f.create(); await f.supervisor.tick(); f.inspect.mockResolvedValue("ready"); await f.supervisor.tick();
    const result = f.store.job(job.id); expect(result.state).toBe("ready"); expect(readFileSync(result.patchArtifact!,"utf8")).toContain("+new");
    expect(result.verification).toBeUndefined(); expect(f.supervisor.snapshot().metrics.verified).toBe(0);
  });
  it("retains the task identity across transient provider polling errors and records a repeated error once",async () => {
    const f = fixture(); const job = f.create(); await f.supervisor.tick(); f.inspect.mockRejectedValue(new Error("Provider unavailable")); await f.supervisor.tick(); await f.supervisor.tick(); await f.supervisor.tick();
    expect(f.store.job(job.id).state).toBe("running"); expect(f.store.job(job.id).taskId).toBeTruthy(); expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.store.events(job.id).filter((event) => event.type === "poll_failed")).toHaveLength(1); expect(f.store.job(job.id).blocker).toBe("Provider unavailable");
  });
  it("spaces provider polls by the configured interval instead of every tick",async () => {
    const f = fixture(); const job = f.create(); await f.supervisor.tick(); f.supervisor.stop(); await f.supervisor.drain();
    const spaced = new Supervisor(f.store,{ ...f.supervisor.options, pollIntervalMs: 60_000 }); supervisors.push(spaced);
    await spaced.tick(); await spaced.tick(); await spaced.tick();
    expect(f.inspect).toHaveBeenCalledTimes(1); expect(f.store.job(job.id).state).toBe("running");
  });
  it("has one controller lease even with two service instances",async () => {
    const f = fixture(); f.create(); const other = new Supervisor(f.store,{ ...f.supervisor.options }); supervisors.push(other);
    await f.supervisor.tick(); await other.tick(); expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it("refuses publication on the local computer",async () => {
    const f = fixture(); const job = f.create(); await expect(f.supervisor.publish(job.id)).rejects.toThrow(/remote supervisor/); expect(f.publisher.publish).not.toHaveBeenCalled();
  });
  it("counts a corrected PR as verified once its head passes, though the correction is the PR's newest job",async () => {
    const f = fixture({ remote: true }); const job = f.create(); await f.supervisor.tick(); f.inspect.mockResolvedValue("ready"); await f.supervisor.tick(); await f.supervisor.publish(job.id);
    const repair = f.supervisor.correction(job.id,"Handle the edge case",randomUUID()); await f.supervisor.tick(); await f.supervisor.tick();
    vi.mocked(f.publisher.publish).mockResolvedValue({ headSha: NEW_SHA,prUrl: "https://github.com/fixture/first/pull/1",prNumber: 1 }); await f.supervisor.publish(repair.id);
    expect(f.supervisor.snapshot().metrics.verified).toBe(0);
    f.store.update(job.id,{ verification: { headSha: NEW_SHA,verdict: "passed",commands: [],evidence: "fixture",at: new Date().toISOString() } });
    expect(f.supervisor.snapshot().metrics).toMatchObject({ prOpened: 1,verified: 1 });
    f.store.update(job.id,{ verification: { headSha: SHA,verdict: "passed",commands: [],evidence: "fixture",at: new Date().toISOString() } });
    expect(f.supervisor.snapshot().metrics.verified).toBe(0);
  });
  it("titles a correction by what it corrects, so its commit on the PR says so",async () => {
    expect(correctionTitle("Add a short header comment to the test. Keep every assertion.")).toBe("Correct: Add a short header comment to the test.");
    expect(correctionTitle("CI still fails\nsee the log")).toBe("Correct: CI still fails");
    expect(correctionTitle("x".repeat(300)).length).toBeLessThanOrEqual(130);
    const f = fixture({ remote: true }); const job = f.create(); await f.supervisor.tick(); f.inspect.mockResolvedValue("ready"); await f.supervisor.tick(); await f.supervisor.publish(job.id);
    expect(f.supervisor.correction(job.id,"Handle the empty list. Then rerun.",randomUUID()).title).toBe("Correct: Handle the empty list.");
  });
  it("keeps the parent's write scope for a correction unless the correction names its own",async () => {
    const f = fixture({ remote: true }); const job = f.create(); await f.supervisor.tick(); f.inspect.mockResolvedValue("ready"); await f.supervisor.tick(); await f.supervisor.publish(job.id);
    expect(f.supervisor.correction(job.id,"Fix the assertion",randomUUID()).writeScopes).toEqual(job.writeScopes);
    const widened = f.supervisor.correction(job.id,"The fix is in the shared helper beside the route",randomUUID(),["tests","app/api/console"]);
    expect(widened.writeScopes).toEqual(["tests","app/api/console"]); expect(widened.outputBranch).toBe(job.outputBranch);
  });
  it("creates a new correction run that updates the same branch and invalidates old evidence",async () => {
    const f = fixture({ remote: true }); const job = f.create(); await f.supervisor.tick(); f.inspect.mockResolvedValue("ready"); await f.supervisor.tick(); await f.supervisor.publish(job.id);
    f.store.update(job.id,{ verification: { headSha: SHA,verdict: "passed",commands: [],evidence: "fixture",at: new Date().toISOString() } });
    const repair = f.supervisor.correction(job.id,"Handle the edge case",randomUUID()); expect(repair.id).not.toBe(job.id); expect(repair.outputBranch).toBe(job.outputBranch); expect(repair.attempt).toBe(2);
    await f.supervisor.tick(); await f.supervisor.tick(); vi.mocked(f.publisher.publish).mockResolvedValue({ headSha: NEW_SHA, prUrl: "https://github.com/fixture/first/pull/1",prNumber: 1 });
    await f.supervisor.publish(repair.id); expect(f.store.job(job.id).verification).toBeUndefined(); expect(f.supervisor.snapshot().metrics.prOpened).toBe(1);
  });
  it("submits through the profile's backend with the repository's routine, the job context and a backend-specific task URL",async () => {
    const f = fixture(); f.supervisor.stop(); await f.supervisor.drain();
    f.store.saveRepository(repositorySchema.parse({ slug: "fixture/first", environmentId: "test-environment", environments: { "claude-cloud": "trig_fixture" } }));
    const submit = vi.fn<ExecutionAdapter["submit"]>(async () => ({ taskId: "session_1", taskUrl: "https://claude.ai/code/session_1" }));
    const adapter: ExecutionAdapter = { capabilities: CLAUDE_CLOUD_CAPABILITIES, submit, inspect: async () => "running", collect: async () => "", list: async () => ({}), describeTask: (id) => ({ taskUrl: `https://claude.ai/code/${id}` }) };
    const claude = new Supervisor(f.store,{ ...f.supervisor.options, profiles: [{ id: "claude", label: "Claude", backend: "claude-cloud", routineTokenEnv: "CLAUDE_ROUTINE_TOKEN_FIXTURE" }], adapter: () => adapter }); supervisors.push(claude);
    const job = claude.create({ requestKey: randomUUID(), repository: "fixture/first", title: "Claude change", brief: "Prove it", profileId: "claude" }); expect(job.backend).toBe("claude-cloud");
    await claude.tick(); expect(f.store.job(job.id).state).toBe("running"); expect(f.store.job(job.id).taskUrl).toBe("https://claude.ai/code/session_1");
    expect(submit.mock.calls[0][0]).toBe("trig_fixture"); expect(submit.mock.calls[0][2]).toContain("Push only to the branch named in the routine payload");
    expect(submit.mock.calls[0][3]).toMatchObject({ jobId: job.id, repository: "fixture/first", baseSha: SHA, sourceRef: `laterdog/input/${job.id}` });
    const uncertain = claude.create({ requestKey: randomUUID(), repository: "fixture/second", title: "No routine", brief: "x", profileId: "claude" }); await claude.tick();
    expect(f.store.job(uncertain.id).state).toBe("needs_attention"); expect(f.store.job(uncertain.id).blocker).toMatch(/No claude-cloud environment/);
    expect(claude.snapshot().backends.map((b) => b.id)).toEqual(["claude-cloud","cursor-cloud","cloudflare-sandbox","claude-managed-agents"]);
    expect(f.supervisor.snapshot().backends.find((b) => b.id === "claude-cloud")?.enabled).toBe(false);
  });
  it("records unsupported native cancellation truthfully",async () => {
    const f = fixture(); const job = f.create(); await f.supervisor.tick(); const result = f.supervisor.cancel(job.id);
    expect(result.cancelRequested).toBe(true); expect(result.state).toBe("running"); expect(f.store.events(job.id)[0].detail).toContain("unavailable");
  });
  it("ties an independent review manifest to the exact parent commit",async () => {
    const f = fixture({ remote: true }); const job = f.create(); await f.supervisor.tick(); f.inspect.mockResolvedValue("ready"); await f.supervisor.tick(); await f.supervisor.publish(job.id);
    const review = f.supervisor.review(job.id,randomUUID()); await f.supervisor.tick();
    const manifest = JSON.stringify({ headSha: SHA,verdict: "pass",summary: "Inspected behavior and test coverage" });
    f.collect.mockResolvedValue(`diff --git a/.laterdog-review.json b/.laterdog-review.json\nnew file mode 100644\n--- /dev/null\n+++ b/.laterdog-review.json\n@@ -0,0 +1 @@\n+${manifest}\n`);
    await f.supervisor.tick(); expect(f.store.job(job.id).review?.reviewerJobId).toBe(review.id); expect(f.store.job(job.id).review?.headSha).toBe(SHA);
  });
  it("keeps a review running through a failed status read, then records its verdict when the provider answers",async () => {
    const f = fixture({ remote: true }); const job = f.create(); await f.supervisor.tick(); f.inspect.mockResolvedValue("ready"); await f.supervisor.tick(); await f.supervisor.publish(job.id);
    const review = f.supervisor.review(job.id,randomUUID()); await f.supervisor.tick();
    f.inspect.mockRejectedValueOnce(new Error("Cloud status read failed (exit 1)")); await f.supervisor.tick();
    expect(f.store.job(review.id).state).toBe("running");
    expect(f.store.events(review.id).some((event) => event.type === "poll_failed")).toBe(true);
    const manifest = JSON.stringify({ headSha: SHA,verdict: "pass",summary: "Checked the new test against the module" });
    f.collect.mockResolvedValue(`diff --git a/.laterdog-review.json b/.laterdog-review.json\nnew file mode 100644\n--- /dev/null\n+++ b/.laterdog-review.json\n@@ -0,0 +1 @@\n+${manifest}\n`);
    await f.supervisor.tick(); expect(f.store.job(job.id).review?.reviewerJobId).toBe(review.id); expect(f.store.job(review.id).state).toBe("ready");
  });
  it("rejects a stale independent review",async () => {
    const f = fixture({ remote: true }); const parent = f.create(); f.store.update(parent.id,{ state: "ready",prUrl: "https://github.com/fixture/first/pull/1",headSha: SHA });
    const review = f.supervisor.review(parent.id,randomUUID()); await f.supervisor.tick(); f.store.update(parent.id,{ headSha: NEW_SHA }); f.inspect.mockResolvedValue("ready");
    f.collect.mockResolvedValue(`diff --git a/.laterdog-review.json b/.laterdog-review.json\n+++ b/.laterdog-review.json\n+${JSON.stringify({ headSha: SHA,verdict: "pass",summary: "Old review" })}\n`);
    await f.supervisor.tick(); expect(f.store.job(review.id).state).toBe("needs_attention"); expect(f.store.job(parent.id).review).toBeUndefined();
  });
});
it("prevents concurrent publication of the same job",async () => {
  const f=fixture({remote:true});const job=f.create();await f.supervisor.tick();f.inspect.mockResolvedValue("ready");await f.supervisor.tick();
  let finish: (() => void) | undefined;
  vi.mocked(f.publisher.publish).mockImplementation(async () => { await new Promise<void>(resolve => { finish=resolve; }); return {headSha:SHA,prUrl:"https://github.com/fixture/first/pull/1",prNumber:1}; });
  const first=f.supervisor.publish(job.id);await expect(f.supervisor.publish(job.id)).rejects.toThrow(/already has an operation/);finish!();await first;expect(f.publisher.publish).toHaveBeenCalledTimes(1);
});
it("invalidates evidence when the published branch moves",async () => {
  const f=fixture({remote:true});const job=f.create();f.store.update(job.id,{state:"ready",prNumber:1,headSha:SHA,verification:{headSha:SHA,verdict:"passed",commands:[],evidence:"fixture",at:new Date().toISOString()}});
  vi.mocked(f.publisher.inspectPublished).mockResolvedValue({headSha:NEW_SHA,state:"OPEN"});await f.supervisor.tick();expect(f.store.job(job.id).headSha).toBe(NEW_SHA);expect(f.store.job(job.id).verification).toBeUndefined();
});
it("retains the result of an uncancellable cloud task but stops further publication after cancellation",async () => {
  const f=fixture({remote:true});const job=f.create();await f.supervisor.tick();f.supervisor.cancel(job.id);f.inspect.mockResolvedValue("ready");await f.supervisor.tick();
  expect(f.store.job(job.id).state).toBe("cancelled");expect(f.store.job(job.id).patchArtifact).toBeTruthy();await expect(f.supervisor.publish(job.id)).rejects.toThrow(/Collect an implementation diff/);
});
it("blocks unauthenticated profiles before preparing or submitting any cloud task",async () => {
  const f=fixture();f.adapter.doctor=async()=>({version:"fixture",authenticated:false,cloudCommands:"fixture"});const job=f.create();await f.supervisor.tick();
  expect(f.store.job(job.id).state).toBe("needs_attention");expect(f.submit).not.toHaveBeenCalled();expect(f.publisher.prepare).not.toHaveBeenCalled();expect(f.store.job(job.id).blocker).toContain("supported subscription");
});
it("records a merge performed on GitHub without claiming the harness performed it",async () => {
 const f=fixture({remote:true});const job=f.create();f.store.update(job.id,{state:"ready",prUrl:"https://github.com/fixture/first/pull/1",prNumber:1,headSha:SHA});vi.mocked(f.publisher.inspectPublished).mockResolvedValue({headSha:SHA,state:"MERGED"});
 await f.supervisor.tick();expect(f.store.job(job.id).state).toBe("merged");expect(f.supervisor.snapshot().metrics.merged).toBe(1);expect(f.supervisor.snapshot().metrics.verified).toBe(0);
});
describe("boundaries and local bridge",() => {
  it("rejects path and repository traversal at input boundaries",() => {
    expect(repositorySchema.safeParse({ slug: "../..",environmentId: "env" }).success).toBe(false);
    expect(createJobSchema.safeParse({ requestKey: "fixture-key",repository: "fixture/first",title: "Test",brief: "Test",writeScopes: ["../credentials"] }).success).toBe(false);
    expect(scopesOverlap(["src/a"],["src/ab"])).toBe(false); expect(scopesOverlap(["src/a"],["src/a/file.ts"])).toBe(true);
  });
  it("pairs once, confines requests, survives reconnect and revokes the device",() => {
    const f = fixture(); const bridge = new BridgeStore(f.store); const pairing = bridge.pairing(["/allowed/repository"]); const device = bridge.pair(pairing.code,"Fixture Mac");
    expect(() => bridge.pair(pairing.code,"Other Mac")).toThrow(/already used/);
    expect(() => bridge.create({ deviceId: device.deviceId,root: "/outside",kind: "inspect_repo" })).toThrow(/not granted/);
    expect(() => bridge.create({ deviceId: device.deviceId,root: "/allowed/repository",kind: "assist" })).toThrow(/not granted/);
    const request = bridge.create({ deviceId: device.deviceId,root: "/allowed/repository",kind: "inspect_repo" }); const identity = bridge.authenticate(device.token)!;
    expect(bridge.poll(identity)?.id).toBe(request.id); expect(bridge.poll(identity)?.id).toBe(request.id);
    bridge.result(identity,request.id,{ branch: "main" },false); expect(bridge.poll(identity)).toBeNull();
    bridge.revoke(device.deviceId); expect(bridge.authenticate(device.token)).toBeUndefined();
    expect(JSON.stringify(bridge.devices())).not.toContain(device.token);
  });
  it("delivers persisted completion wakeups with the same send ID after an uncertain network outcome",async () => {
    const f = fixture(); const job = f.create({ botId: "fixturebot",conversationId: "fixturethread" });
    f.store.update(job.id,{ state: "ready" },"collected","Result received");
    const calls: unknown[] = []; const failed = vi.fn(async (_url: string | URL | Request,options?: RequestInit) => { calls.push(JSON.parse(String(options?.body))); throw new Error("Connection lost"); });
    await expect(deliverOutbox(f.store,"http://127.0.0.1:9999",undefined,failed as typeof fetch)).rejects.toThrow(/Connection lost/);
    const success = vi.fn(async (_url: string | URL | Request,options?: RequestInit) => { calls.push(JSON.parse(String(options?.body))); return new Response("{}",{ status: 202 }); });
    await deliverOutbox(f.store,"http://127.0.0.1:9999",undefined,success as typeof fetch); await deliverOutbox(f.store,"http://127.0.0.1:9999",undefined,success as typeof fetch);
    expect(calls[0]).toEqual(calls[1]); expect(success).toHaveBeenCalledTimes(1);
  });
});
export type { Job, Repository };
