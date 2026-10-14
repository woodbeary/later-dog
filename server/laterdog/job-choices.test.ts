import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createJobSchema, repositorySchema, type Profile } from "../../shared/laterdog.ts";
import { cloudTaskSummary } from "../../shared/cloud-task.ts";
import { WorkspaceStore } from "./store.ts";
import { Supervisor, type SupervisorOptions } from "./supervisor.ts";
import type { ExecutionAdapter, JobContext } from "./codex-cloud.ts";
import { LATERDOG_CLOUD_CAPABILITIES } from "./laterdog-cloud.ts";
import { GitHubPublisher } from "./github.ts";
import { LocalTraceStore, StateTraceStore, captureTrace, type JobTraceStore } from "./job-trace.ts";
import { FakeTraceState, slurp } from "./trace-state-fake.ts";
import { dogJobDefaults, dogJobEnvironment } from "./job-defaults.ts";

const SHA = "a".repeat(40);
const PATCH = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const dirs: string[] = []; const stores: WorkspaceStore[] = []; const supervisors: Supervisor[] = [];
afterEach(() => { supervisors.splice(0).forEach((s) => s.stop()); stores.splice(0).forEach((s) => s.close()); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });

const personal: Profile = { id: "personal", label: "Personal Claude", backend: "laterdog-cloud", account: "claude", maxComputerSize: "xlarge" };
const work: Profile = { id: "work", label: "Work Claude", backend: "laterdog-cloud", account: "claude-2", claudeTokenEnv: "CLAUDE_CODE_OAUTH_TOKEN_WORK", maxComputerSize: "xlarge" };
const codex: Profile = { id: "default", label: "Codex" };

function fixture(options: { profiles?: Profile[]; traces?: { primary: JobTraceStore; local: LocalTraceStore }; trace?: ExecutionAdapter["trace"]; state?: "ready" | "failed"; supervisor?: Partial<SupervisorOptions>; capabilities?: ExecutionAdapter["capabilities"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-choices-")); dirs.push(dir);
  const store = new WorkspaceStore(":memory:"); stores.push(store);
  store.saveRepository(repositorySchema.parse({ slug: "fixture/first", environmentId: "none", environments: { "laterdog-cloud": "none" } }));
  const contexts: (JobContext | undefined)[] = [];
  const order: string[] = [];
  const adapter: ExecutionAdapter = {
    capabilities: options.capabilities ?? LATERDOG_CLOUD_CAPABILITIES,
    submit: vi.fn(async (_environment, _ref, _prompt, context) => { contexts.push(context); return { taskId: `cmp_${randomUUID().replace(/-/g, "").slice(0, 12)}`, taskUrl: "" }; }),
    inspect: vi.fn(async () => options.state ?? "ready"),
    collect: vi.fn(async () => { order.push("collect"); return PATCH; }),
    list: async () => ({ tasks: [] }),
    ...(options.trace ? { trace: vi.fn(async (taskId: string) => { order.push("trace"); return options.trace!(taskId); }) } : {}),
  };
  const publisher = new GitHubPublisher(join(dir, "checkouts"));
  vi.spyOn(publisher, "prepare").mockImplementation(async (job) => ({ baseSha: SHA, sourceRef: `laterdog/input/${job.id}` }));
  const local = new LocalTraceStore(join(dir, "traces"));
  const supervisor = new Supervisor(store, { dataDir: dir, profiles: options.profiles ?? [personal], concurrency: 4, publishingHost: "local", publisher, adapter: () => adapter,
    traceRetryMs: [0], traceSweepMs: 0, traces: options.traces ?? { primary: local, local }, ...options.supervisor });
  supervisors.push(supervisor);
  const create = (overrides: Record<string, unknown> = {}) => supervisor.create({ requestKey: randomUUID(), repository: "fixture/first", title: "Fixture change", brief: "Prove it", writeScopes: ["src"], profileId: "personal", ...overrides });
  return { dir, store, supervisor, adapter, contexts, order, create, local };
}

describe("a job's model, effort and account", () => {
  it("carries them from the request to the record and on to the computer's launch", async () => {
    const f = fixture({ state: "ready" });
    const job = f.create({ model: "claude-opus-5-5", effort: "high", account: "claude", computerSize: "large" });
    expect(f.store.job(job.id)).toMatchObject({ model: "claude-opus-5-5", effort: "high", account: "claude", computerSize: "large" });
    await f.supervisor.tick();
    expect(f.contexts[0]).toMatchObject({ jobId: job.id, model: "claude-opus-5-5", effort: "high", account: "claude", computerSize: "large" });
  });

  it("leaves them out of the launch when nobody chose, so the computer runs with its defaults", async () => {
    const f = fixture();
    f.create();
    await f.supervisor.tick();
    expect(f.contexts[0]).not.toHaveProperty("model");
    expect(f.contexts[0]).not.toHaveProperty("effort");
    expect(f.contexts[0]).not.toHaveProperty("computerSize");
  });

  it("refuses a model that is not a model id, an unknown effort and an unknown size", () => {
    const base = { requestKey: randomUUID(), repository: "fixture/first", title: "x", brief: "y" };
    expect(() => createJobSchema.parse({ ...base, model: "a b" })).toThrow();
    expect(() => createJobSchema.parse({ ...base, model: "$(reboot)" })).toThrow();
    expect(() => createJobSchema.parse({ ...base, effort: "turbo" })).toThrow();
    expect(() => createJobSchema.parse({ ...base, effort: "none" })).toThrow();
    expect(() => createJobSchema.parse({ ...base, computerSize: "huge" })).toThrow();
    expect(createJobSchema.parse({ ...base, model: "claude-sonnet-5-5[1m]", effort: "ultra", account: "claude-2", computerSize: "xlarge" })).toMatchObject({ effort: "ultra" });
  });

  it("sends a delegation to the cloud profile signed in to the account it names, and says so when none is", () => {
    const f = fixture({ profiles: [personal, work, codex] });
    expect(f.supervisor.preferredProfile("claude-2")).toBe("work");
    expect(f.supervisor.preferredProfile("work")).toBe("work");
    expect(f.supervisor.preferredProfile("claude")).toBe("personal");
    expect(f.supervisor.preferredProfile("claude-9")).toBe("personal");
    expect(f.supervisor.preferredProfile()).toBe("personal");
    const request = { requestKey: randomUUID(), repository: "fixture/first", title: "Defaulted", brief: "x", writeScopes: ["src"], profileId: "personal", account: "claude-9" };
    const noted = f.supervisor.create(request, { profileDefaulted: true });
    expect(f.store.events(noted.id).find((event) => event.type === "account_differs")?.detail).toMatch(/claude-9.*Personal Claude/);
    f.supervisor.create(request, { profileDefaulted: true });
    expect(f.store.events(noted.id).filter((event) => event.type === "account_differs")).toHaveLength(1);
    const matched = f.supervisor.create({ ...request, requestKey: randomUUID(), account: "claude" }, { profileDefaulted: true });
    expect(f.store.events(matched.id).some((event) => event.type === "account_differs")).toBe(false);
  });

  it("makes a correction or a review run the way its parent did", () => {
    const f = fixture({ profiles: [personal, codex] });
    const parent = f.create({ model: "claude-opus-5-5", effort: "max", account: "claude", computerSize: "standard" });
    f.store.update(parent.id, { prUrl: "https://github.com/fixture/first/pull/1", headSha: SHA, state: "ready" });
    expect(f.supervisor.correction(parent.id, "Fix the typo", randomUUID())).toMatchObject({ model: "claude-opus-5-5", effort: "max", account: "claude", computerSize: "standard" });
    expect(f.supervisor.review(parent.id, randomUUID())).toMatchObject({ model: "claude-opus-5-5", effort: "max" });
    expect(f.supervisor.review(parent.id, randomUUID(), "default").model).toBeUndefined();
  });

  it("shows them, with the account's name, on the cloud task summary", () => {
    const f = fixture({ profiles: [personal, work] });
    const job = f.create({ profileId: "work", model: "claude-opus-5-5", effort: "xhigh", account: "claude-2", computerSize: "large" });
    expect(f.supervisor.summaries({ ids: [job.id] })[0]).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh", account: "Work Claude", computerSize: "large" });
    const bare = f.create({ requestKey: randomUUID() });
    const summary = f.supervisor.summaries({ ids: [bare.id] })[0];
    expect(summary).toMatchObject({ account: "Personal Claude" });
    expect(summary).not.toHaveProperty("model");
    expect(summary).not.toHaveProperty("effort");
  });
});

describe("what a dog hands its delegations by default", () => {
  it("passes a Claude dog's own account, model and effort, and nothing for a dog on another engine", () => {
    expect(dogJobEnvironment({ instanceId: "claude-2", model: "claude-opus-5-5", effort: "high" }, "claudeAgent")).toEqual({ LATERDOG_ACCOUNT: "claude-2", LATERDOG_MODEL: "claude-opus-5-5", LATERDOG_EFFORT: "high" });
    expect(dogJobEnvironment({ instanceId: "codex", model: "gpt-5", effort: "high" }, "codex")).toEqual({});
    expect(dogJobEnvironment(undefined, "claudeAgent")).toEqual({});
    expect(dogJobEnvironment({ instanceId: "claude", model: "claude-sonnet-5-5", effort: "none" }, "claudeAgent")).toEqual({ LATERDOG_ACCOUNT: "claude", LATERDOG_MODEL: "claude-sonnet-5-5" });
    expect(dogJobEnvironment({ instanceId: "claude", model: "not a model", effort: "high" }, "claudeAgent")).toEqual({ LATERDOG_ACCOUNT: "claude", LATERDOG_EFFORT: "high" });
  });

  it("reads them back for the delegate tool and ignores anything malformed", () => {
    expect(dogJobDefaults({ LATERDOG_ACCOUNT: "claude-2", LATERDOG_MODEL: "claude-opus-5-5", LATERDOG_EFFORT: "max" })).toEqual({ account: "claude-2", model: "claude-opus-5-5", effort: "max" });
    expect(dogJobDefaults({ LATERDOG_MODEL: "$(reboot)", LATERDOG_EFFORT: "turbo", LATERDOG_ACCOUNT: "a b" })).toEqual({});
    expect(dogJobDefaults({})).toEqual({});
  });
});

describe("a job's trace", () => {
  const trace = async (_taskId?: string) => captureTrace(gzipSync(Buffer.from('{"type":"result"}\n')), false, []);

  it("is uploaded before the computer is collected and deleted, and recorded on the job", async () => {
    const state = new FakeTraceState();
    const local = new LocalTraceStore(join(mkdtempSync(join(tmpdir(), "laterdog-local-")), "t"));
    const f = fixture({ trace, traces: { primary: new StateTraceStore("http://state.r2", { fetch: state.fetch }), local } });
    const job = f.create();
    await f.supervisor.tick();
    await f.supervisor.tick();
    await f.supervisor.drain();
    expect(f.order).toEqual(["trace", "collect"]);
    const done = f.store.job(job.id);
    expect(done).toMatchObject({ state: "ready", trace: { where: "r2", truncated: false } });
    expect(state.objects.has(`traces/${job.id}.jsonl.gz`)).toBe(true);
    expect((await slurp((await f.supervisor.trace(job.id)).stream))!.toString()).toBe('{"type":"result"}\n');
    expect(f.supervisor.summaries({ ids: [job.id] })[0].trace).toBeDefined();
  });

  it("is kept for a failed job too, and for a job that is stopped", async () => {
    const failed = fixture({ trace, state: "failed" });
    const bad = failed.create();
    await failed.supervisor.tick();
    await failed.supervisor.tick();
    expect(failed.store.job(bad.id)).toMatchObject({ state: "needs_attention", trace: { where: "local" } });
    const stopping = fixture({ trace, state: "failed" });
    const adapter = stopping.adapter as ExecutionAdapter & { cancel?: (taskId: string) => Promise<void> };
    adapter.cancel = vi.fn(async () => undefined);
    const job = stopping.create();
    await stopping.supervisor.tick();
    stopping.store.update(job.id, { state: "running" });
    await stopping.supervisor.stopJob(job.id);
    expect(stopping.store.job(job.id).trace).toBeDefined();
    expect(adapter.cancel).toHaveBeenCalled();
  });

  it("retries a failing upload, then falls back to this supervisor's disk and says so", async () => {
    const state = new FakeTraceState();
    state.failPuts = 1;
    const local = new LocalTraceStore(join(mkdtempSync(join(tmpdir(), "laterdog-local-")), "t"));
    const retried = fixture({ trace, traces: { primary: new StateTraceStore("http://state.r2", { fetch: state.fetch }), local } });
    const a = retried.create();
    await retried.supervisor.tick(); await retried.supervisor.tick();
    await retried.supervisor.drain();
    expect(retried.store.job(a.id).trace?.where).toBe("r2");
    expect(state.requests.filter((request) => request.method === "PUT")).toHaveLength(2);
    state.failPuts = 5;
    const b = retried.create();
    await retried.supervisor.tick(); await retried.supervisor.tick();
    await retried.supervisor.drain();
    expect(retried.store.job(b.id)).toMatchObject({ state: "ready", trace: { where: "local" } });
    expect(retried.store.events(b.id).some((event) => event.type === "trace_kept_locally")).toBe(true);
    expect((await slurp((await retried.supervisor.trace(b.id)).stream))!.length).toBeGreaterThan(0);
  });

  it("never holds up the diff when no store will take it", async () => {
    const broken: JobTraceStore = { where: "r2", put: async () => { throw new Error("R2 is down"); }, open: async () => null };
    const local = { where: "local" as const, put: async () => { throw new Error("disk full"); }, open: async () => null, forget: () => undefined, sweep: () => 0 } as unknown as LocalTraceStore;
    const f = fixture({ trace, traces: { primary: broken, local } });
    const job = f.create();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await f.supervisor.tick(); await f.supervisor.tick();
    const done = f.store.job(job.id);
    expect(done.state).toBe("ready");
    expect(done.trace).toBeUndefined();
    expect(f.store.events(job.id).find((event) => event.type === "trace_not_kept")?.detail).toMatch(/disk full/);
    await expect(f.supervisor.trace(job.id)).rejects.toMatchObject({ status: 404 });
  });

  it("is refused once it has expired, and its local file is swept", async () => {
    const f = fixture({ trace });
    const job = f.create();
    await f.supervisor.tick(); await f.supervisor.tick();
    const kept = f.store.job(job.id).trace!;
    expect(existsSync(join(f.dir, "traces", `${job.id}.jsonl.gz`))).toBe(true);
    f.store.update(job.id, { trace: { ...kept, expiresAt: new Date(Date.now() - 1000).toISOString() } });
    await expect(f.supervisor.trace(job.id)).rejects.toMatchObject({ status: 410 });
    expect(f.supervisor.summaries({ ids: [job.id] })[0].trace).toBeUndefined();
    await f.supervisor.tick();
    expect(existsSync(join(f.dir, "traces", `${job.id}.jsonl.gz`))).toBe(false);
  });

  it("is kept for an adapter that cannot read one as nothing at all", async () => {
    const f = fixture();
    const job = f.create();
    await f.supervisor.tick(); await f.supervisor.tick();
    expect(f.store.job(job.id).trace).toBeUndefined();
    await expect(f.supervisor.trace(job.id)).rejects.toMatchObject({ status: 404 });
    expect(cloudTaskSummary(f.store.job(job.id))).not.toHaveProperty("trace");
  });
});

describe("how long a trace may hold anything up", () => {
  const trace = async () => captureTrace(gzipSync(Buffer.from('{"type":"result"}\n')), false, []);
  const hang = () => new Promise<never>(() => undefined);

  it("gives up capturing after its budget and still collects the diff", async () => {
    const f = fixture({ trace: hang, supervisor: { traceBudgetMs: 40 } });
    const job = f.create();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await f.supervisor.tick();
    const started = Date.now();
    await f.supervisor.tick();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(f.store.job(job.id).state).toBe("ready");
    expect(f.order).toEqual(["trace", "collect"]);
    expect(f.store.events(job.id).find((event) => event.type === "trace_not_kept")?.detail).toMatch(/took longer/);
  });

  it("keeps a captured trace on disk at once and uploads it off the tick", async () => {
    const local = new LocalTraceStore(join(mkdtempSync(join(tmpdir(), "laterdog-local-")), "t"));
    const slow: JobTraceStore = {
      where: "r2",
      put: (_jobId, _gz, upload) => new Promise((_resolve, reject) => { upload.signal?.addEventListener("abort", () => reject(new Error("the upload timed out"))); }),
      open: async () => null,
    };
    const f = fixture({ trace, traces: { primary: slow, local }, supervisor: { traceBudgetMs: 60, traceRetryMs: [] } });
    const job = f.create();
    await f.supervisor.tick();
    await f.supervisor.tick();
    expect(f.store.job(job.id)).toMatchObject({ state: "ready", trace: { where: "local" } });
    await f.supervisor.drain();
    expect(f.store.events(job.id).find((event) => event.type === "trace_kept_locally")?.detail).toMatch(/timed out/);
    expect(f.store.job(job.id).trace?.where).toBe("local");
  });

  it("moves the record to R2 when the background upload lands, and drops the local copy", async () => {
    const state = new FakeTraceState();
    const local = new LocalTraceStore(join(mkdtempSync(join(tmpdir(), "laterdog-local-")), "t"));
    const f = fixture({ trace, traces: { primary: new StateTraceStore("http://state.r2", { fetch: state.fetch }), local } });
    const job = f.create();
    await f.supervisor.tick();
    await f.supervisor.tick();
    await f.supervisor.drain();
    expect(f.store.job(job.id).trace?.where).toBe("r2");
    expect(await local.open(job.id)).toBeNull();
  });

  it("stops within seconds even when the trace will not come", async () => {
    const f = fixture({ trace: hang, state: "failed", supervisor: { traceStopCapMs: 30, traceBudgetMs: 60_000 } });
    const adapter = f.adapter as ExecutionAdapter & { cancel?: (taskId: string) => Promise<void> };
    adapter.cancel = vi.fn(async () => undefined);
    const job = f.create();
    await f.supervisor.tick();
    f.store.update(job.id, { state: "running" });
    const started = Date.now();
    await f.supervisor.stopJob(job.id);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(adapter.cancel).toHaveBeenCalled();
  });

  it("asks for the trace once when the poll and a stop both want it", async () => {
    let calls = 0;
    const f = fixture({ trace: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 30)); return captureTrace(gzipSync(Buffer.from("{}\n")), false, []); }, state: "failed" });
    const adapter = f.adapter as ExecutionAdapter & { cancel?: (taskId: string) => Promise<void> };
    adapter.cancel = vi.fn(async () => undefined);
    const job = f.create();
    await f.supervisor.tick();
    f.store.update(job.id, { state: "running" });
    await Promise.all([f.supervisor.stopJob(job.id), f.supervisor.stopJob(job.id)]);
    await f.supervisor.drain();
    expect(calls).toBe(1);
  });

  it("says why when the computer had nothing to keep", async () => {
    const f = fixture({ trace: async () => null });
    const job = f.create();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await f.supervisor.tick(); await f.supervisor.tick();
    expect(f.store.events(job.id).find((event) => event.type === "trace_not_kept")?.detail).toMatch(/no event stream/);
  });
});

describe("the computer size a job may ask for", () => {
  const small: Profile = { id: "small", label: "Small only", backend: "laterdog-cloud" };
  const capped: Profile = { id: "capped", label: "Up to large", backend: "laterdog-cloud", maxComputerSize: "large", computerSize: "xlarge" };
  const legacy: Profile = { id: "legacy", label: "Old config", backend: "laterdog-cloud", computerSize: "standard" };

  it("clamps a request above the profile's ceiling and records what ran", () => {
    const f = fixture({ profiles: [small, capped, legacy] });
    const over = f.create({ profileId: "small", computerSize: "xlarge" });
    expect(f.store.job(over.id).computerSize).toBe("small");
    expect(f.store.events(over.id).find((event) => event.type === "computer_size_clamped")?.detail).toBe("Asked for a xlarge computer; ran on small (this profile allows up to small)");
    expect(f.create({ profileId: "capped", computerSize: "xlarge" }).computerSize).toBe("large");
    expect(f.create({ profileId: "capped", computerSize: "standard" }).computerSize).toBe("standard");
    expect(f.create({ profileId: "legacy", computerSize: "large" }).computerSize).toBe("standard");
    expect(f.create({ profileId: "legacy", computerSize: "standard" }).computerSize).toBe("standard");
  });

  it("records nothing when the request fits or none was made", () => {
    const f = fixture({ profiles: [small, capped] });
    const fits = f.create({ profileId: "capped", computerSize: "large" });
    const none = f.create({ profileId: "small" });
    for (const job of [fits, none]) expect(f.store.events(job.id).some((event) => event.type === "computer_size_clamped")).toBe(false);
    expect(f.store.job(none.id).computerSize).toBeUndefined();
  });

  it("clamps again if the same request is made twice, with one event", () => {
    const f = fixture({ profiles: [small] });
    const requestKey = randomUUID();
    f.create({ profileId: "small", computerSize: "large", requestKey });
    const again = f.create({ profileId: "small", computerSize: "large", requestKey });
    expect(f.store.events(again.id).filter((event) => event.type === "computer_size_clamped")).toHaveLength(1);
  });
});

describe("what a job shows about itself, honestly", () => {
  it("keeps a model, effort and size off a job on a backend that cannot use them", () => {
    const f = fixture({ profiles: [personal, codex], capabilities: { ...LATERDOG_CLOUD_CAPABILITIES, id: "codex-cloud" } });
    const job = f.create({ profileId: "default", model: "claude-opus-5-5", effort: "high", computerSize: "large", account: "claude" });
    expect(f.store.job(job.id).model).toBeUndefined();
    expect(f.store.job(job.id).effort).toBeUndefined();
    expect(f.store.job(job.id).computerSize).toBeUndefined();
    expect(f.store.events(job.id).some((event) => event.type === "choices_ignored")).toBe(true);
    const summary = f.supervisor.summaries({ ids: [job.id] })[0];
    for (const field of ["model", "effort", "computerSize"]) expect(summary).not.toHaveProperty(field);
  });

  it("notes a different account only when the cloud profile was picked for the job", () => {
    const f = fixture({ profiles: [personal, work] });
    const asked = { account: "claude-3", model: "claude-opus-5-5" };
    const explicit = f.create({ profileId: "personal", ...asked });
    expect(f.store.events(explicit.id).some((event) => event.type === "account_differs")).toBe(false);
    const request = { requestKey: randomUUID(), repository: "fixture/first", title: "Defaulted", brief: "x", writeScopes: ["src"], profileId: "personal", ...asked };
    const defaulted = f.supervisor.create(request, { profileDefaulted: true });
    expect(f.store.events(defaulted.id).some((event) => event.type === "account_differs")).toBe(true);
    const matching = f.supervisor.create({ ...request, requestKey: randomUUID(), account: "claude" }, { profileDefaulted: true });
    expect(f.store.events(matching.id).some((event) => event.type === "account_differs")).toBe(false);
  });
});
