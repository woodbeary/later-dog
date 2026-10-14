import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeJob, createJobSchema, repositorySchema, scopesOverlap, type BackendId, type CreateJob, type Job, type JobTrace, type Profile, type WorkspaceSnapshot } from "../../shared/laterdog.ts";
import { MAX_ACTIVITY_PAGE_BYTES, cloudTaskSummary, parseCloudTaskSteps, patchChanges, type CloudTaskActivityPage, type CloudTaskSummary } from "../../shared/cloud-task.ts";
import { CodexCloudAdapter, SubmissionUnknown, type ExecutionAdapter, type JobContext } from "./codex-cloud.ts";
import { ClaudeCloudAdapter, CLAUDE_CLOUD_CAPABILITIES } from "./claude-cloud.ts";
import { LaterdogCloudAdapter, LATERDOG_CLOUD_CAPABILITIES } from "./laterdog-cloud.ts";
import { GitHubPublisher } from "./github.ts";
import { GitHubDeviceLogin } from "./github-login.ts";
import { WorkspaceStore } from "./store.ts";
import { measuredOutcomes } from "./observations.ts";
import { deliverOutbox } from "./notifications.ts";
import { clampComputerSize, computerCeiling } from "./job-defaults.ts";
import { LocalTraceStore, jobTraceStoreFromEnv, readableTraceStream, traceExpired, traceRetentionDays, type JobTraceStore, type TraceCapture } from "./job-trace.ts";
import type { Readable } from "node:stream";

export interface SupervisorOptions {
  dataDir: string;
  profiles: Profile[];
  concurrency: number;
  publishingHost: "local" | "remote";
  pollIntervalMs?: number;
  adapter?: (profile: Profile) => ExecutionAdapter;
  publisher?: GitHubPublisher;
  githubLogin?: GitHubDeviceLogin;
  workspaceUrl?: string;
  workspaceTokenFile?: string;
  traces?: { primary: JobTraceStore; local: LocalTraceStore };
  traceRetentionDays?: number;
  traceRetryMs?: number[];
  traceBudgetMs?: number;
  traceStopCapMs?: number;
  traceSweepMs?: number;
}

export function correctionTitle(brief: string): string {
  const first = brief.trim().split(/(?<=[.!?])\s|\n/)[0]?.trim() ?? "";
  const line = first.length > 120 ? `${first.slice(0, 119).trimEnd()}…` : first;
  return `Correct: ${line || "address the review"}`;
}

const TRACE_BUDGET_MS = 30_000;
const TRACE_STOP_CAP_MS = 5_000;

function settleWithin<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  work.catch(() => undefined);
  const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.max(Math.round(ms / 1000), 1)} s`)), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

function inherited(parent: Job): Pick<CreateJob, "model" | "effort" | "account" | "computerSize"> {
  return { ...(parent.model ? { model: parent.model } : {}), ...(parent.effort ? { effort: parent.effort } : {}), ...(parent.account ? { account: parent.account } : {}), ...(parent.computerSize ? { computerSize: parent.computerSize } : {}) };
}

export class Supervisor {
  readonly owner = randomUUID();
  private readonly adapters = new Map<string, ExecutionAdapter>();
  private readonly inFlight = new Set<string>();
  private readonly lastPolled = new Map<string, number>();
  private recovered = false;
  private stopped = false;
  private lastHeadCheck = 0;
  private headCursor = 0;
  private readonly publisher: GitHubPublisher;
  private readonly githubLogin: GitHubDeviceLogin;
  private readonly artifactDir: string;
  private readonly traces: { primary: JobTraceStore; local: LocalTraceStore };
  private lastTraceSweep = 0;
  private readonly tracing = new Map<string, Promise<void>>();
  private readonly uploads = new Set<Promise<void>>();
  readonly store: WorkspaceStore;
  readonly options: SupervisorOptions;
  constructor(store: WorkspaceStore, options: SupervisorOptions) {
    this.store = store; this.options = options;
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 100) throw new Error("Concurrency must be 1–100");
    this.artifactDir = join(options.dataDir, "artifacts"); mkdirSync(this.artifactDir, { recursive: true, mode: 0o700 });
    this.traces = options.traces ?? jobTraceStoreFromEnv(process.env, options.dataDir);
    this.publisher = options.publisher ?? new GitHubPublisher(join(options.dataDir, "checkouts"));
    this.githubLogin = options.githubLogin ?? new GitHubDeviceLogin();
    for (const profile of options.profiles) this.adapters.set(profile.id, options.adapter?.(profile) ?? (profile.backend === "claude-cloud"
      ? new ClaudeCloudAdapter(profile, { cwd: options.dataDir }) : profile.backend === "laterdog-cloud" ? new LaterdogCloudAdapter(profile)
        : new CodexCloudAdapter(profile, undefined, { cwd: options.dataDir })));
  }
  private context(job: Job): JobContext {
    return { jobId: job.id, repository: job.repository, sourceRef: job.sourceRef, baseSha: job.baseSha, createdAt: job.createdAt,
      ...(job.model ? { model: job.model } : {}), ...(job.effort ? { effort: job.effort } : {}), ...(job.account ? { account: job.account } : {}), ...(job.computerSize ? { computerSize: job.computerSize } : {}) };
  }
  create(input: unknown, how: { profileDefaulted?: boolean } = {}): Job {
    const parsed = createJobSchema.parse(input);
    const adapter = this.adapters.get(parsed.profileId); if (!adapter) throw new Error("Unknown account profile");
    const backend = adapter.capabilities.id as BackendId;
    const profile = this.options.profiles.find((candidate) => candidate.id === parsed.profileId);
    const cloud = backend === "laterdog-cloud";
    const { model, effort, computerSize, ...rest } = parsed;
    const sizing = cloud && computerSize ? clampComputerSize(computerSize, computerCeiling(profile)) : undefined;
    const request: CreateJob = cloud ? { ...rest, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(sizing ? { computerSize: sizing.size } : {}) } : rest;
    const job = this.store.create(request, backend);
    const recorded = (type: string) => this.store.events(job.id).some((event) => event.type === type);
    if (sizing?.clamped && !recorded("computer_size_clamped")) {
      this.store.update(job.id, {}, "computer_size_clamped", `Asked for a ${computerSize} computer; ran on ${sizing.size} (this profile allows up to ${sizing.size})`);
    }
    if (!cloud && (model || effort || computerSize) && !recorded("choices_ignored")) {
      this.store.update(job.id, {}, "choices_ignored", "This backend does not take a model, effort or computer size, so they were not applied");
    }
    if (how.profileDefaulted && cloud && request.account && profile && profile.account !== request.account && profile.id !== request.account && !recorded("account_differs")) {
      this.store.update(job.id, {}, "account_differs", `Asked for account ${request.account}; no cloud profile is signed in to it, so this runs on ${profile.label}`);
    }
    return job;
  }
  correction(id: string, brief: string, requestKey: string, writeScopes?: string[]): Job {
    const parent = this.store.job(id);
    if (parent.state === "merged" || parent.state === "cancelled") throw new Error("Create a new implementation job after the parent PR has shipped or been cancelled");
    if (!parent.prUrl || !parent.headSha) throw new Error("Publish the result branch before requesting a correction");
    return this.create({ requestKey, repository: parent.repository, title: correctionTitle(brief), brief,
      standingInstructions: parent.standingInstructions, writeScopes: writeScopes ?? parent.writeScopes, dependencies: [id],
      profileId: parent.profileId, kind: "repair", parentId: id, conversationId: parent.conversationId, botId: parent.botId, ...inherited(parent) });
  }
  review(id: string, requestKey: string, profileId?: string): Job {
    const parent = this.store.job(id);
    if (!parent.headSha || !parent.prUrl) throw new Error("Publish the result before requesting independent review");
    const brief = `Independently review PR ${parent.prUrl} at commit ${parent.headSha}. Read the change, requirements, tests and relevant surrounding code. Do not edit product code. Write one new root file .laterdog-review.json with JSON: {"headSha":"${parent.headSha}","verdict":"pass" or "changes_requested","summary":"concrete findings and what you actually checked"}. This file is collected as review evidence and is not published to the product branch.\n\nRequirements:\n${parent.brief}`;
    return this.create({ requestKey, repository: parent.repository, title: `Review: ${parent.title}`, brief, standingInstructions: parent.standingInstructions,
      writeScopes: [".laterdog-review.json"], dependencies: [id], profileId: profileId ?? parent.profileId, kind: "review", parentId: id, conversationId: parent.conversationId, botId: parent.botId, ...(profileId ? {} : inherited(parent)) });
  }
  snapshot(): WorkspaceSnapshot {
    const jobs = this.store.jobs(); const prs = new Map<string, Job[]>();
    for (const job of jobs) if (job.prUrl) prs.set(job.prUrl, [...(prs.get(job.prUrl) ?? []), job]);
    return { jobs, repositories: this.store.repositories(), profiles: this.options.profiles.map(({ id, label }) => ({ id, label })),
      backends: this.backends(), concurrency: this.options.concurrency,
      active: jobs.filter(activeJob).length, publishingHost: this.options.publishingHost, wakeupsConfigured: Boolean(this.options.workspaceUrl),
      measurements: measuredOutcomes(this.store),
      metrics: { prOpened: prs.size, verified: [...prs.values()].filter((group) => group.some((j) => j.verification?.verdict === "passed" && j.verification.headSha === group[0].headSha)).length,
        merged: new Set(jobs.filter((j) => j.state === "merged").map((j) => j.prUrl)).size,
        needsAttention: jobs.filter((j) => j.state === "needs_attention" || j.state === "submission_unknown").length,
        repairs: jobs.filter((j) => j.kind === "repair").length } };
  }
  private backends(): WorkspaceSnapshot["backends"] {
    const configured = new Map<string, WorkspaceSnapshot["backends"][number]>();
    for (const adapter of this.adapters.values()) configured.set(adapter.capabilities.id, adapter.capabilities);
    if (!configured.has(CLAUDE_CLOUD_CAPABILITIES.id)) configured.set(CLAUDE_CLOUD_CAPABILITIES.id, { ...CLAUDE_CLOUD_CAPABILITIES, enabled: false, limitation: `Add an account profile with backend "claude-cloud", a routine token environment variable and a per-repository routine ID to enable it. ${CLAUDE_CLOUD_CAPABILITIES.limitation}` });
    if (!configured.has(LATERDOG_CLOUD_CAPABILITIES.id)) configured.set(LATERDOG_CLOUD_CAPABILITIES.id, { ...LATERDOG_CLOUD_CAPABILITIES, enabled: false, limitation: `Add an account profile with backend "laterdog-cloud", set CLAUDE_CODE_OAUTH_TOKEN on the supervisor, give it the computers service (the hosted supervisor's COMPUTERS binding, or LATERDOG_COMPUTERS_URL and LATERDOG_COMPUTERS_KEY), and set each repository's laterdog-cloud setup command (or "none") to enable it. ${LATERDOG_CLOUD_CAPABILITIES.limitation}` });
    return [...configured.values(),
      { id: "cursor-cloud", label: "Cursor Cloud", enabled: false, submission: false, continuation: false, cancellation: false, activity: "polled", billing: "api-and-compute", limitation: "Adapter workflow is not yet qualified. Conversation providers remain available independently." },
      { id: "cloudflare-sandbox", label: "Cloudflare sandbox runner", enabled: false, submission: false, continuation: false, cancellation: false, activity: "streamed", billing: "api-and-compute", limitation: "Hosting the supervisor on Cloudflare is supported; running agents inside Cloudflare's Sandbox SDK is not, because only API-key billing is documented there and subscription authentication inside a sandbox is unqualified. No paid fallback is enabled. later.dog Cloud (laterdog-cloud) runs Claude Code on the owner's own later.dog computers instead." },
      { id: "claude-managed-agents", label: "Claude Managed Agents", enabled: false, submission: false, continuation: false, cancellation: false, activity: "polled", billing: "api-and-compute", limitation: "Has a real session API but bills Claude Platform usage, not the subscription; not qualified." },
    ];
  }
  private remote(): void {
    if (this.options.publishingHost !== "remote") throw Object.assign(new Error("Publishing and repository verification require a remote supervisor. Connect one; heavy work will not fall back to this Mac."), { status: 409 });
  }
  async inspectProfile(id: string): Promise<unknown> {
    const adapter = this.adapters.get(id); if (!adapter) throw new Error("Unknown account profile");
    return adapter.doctor ? { ...await adapter.doctor(), allowance: null, environmentCompatibility: "Requires a complete round trip for the configured environment" } : { limitation: "This adapter cannot inspect authentication or allowances" };
  }
  async inspectGitHub() { return { ...await this.publisher.access(), signIn: this.githubLogin.status() }; }
  loginGitHub() { return this.githubLogin.start(); }
  async listProfileTasks(id: string): Promise<unknown> {
    const adapter = this.adapters.get(id); if (!adapter) throw new Error("Unknown account profile"); return adapter.list();
  }
  async loginProfile(id: string): Promise<unknown> {
    const adapter = this.adapters.get(id); if (!adapter) throw new Error("Unknown account profile");
    if (!adapter.login) throw new Error("This adapter cannot start a login; sign in with the provider's own tooling");
    return adapter.login();
  }
  private adapter(job: Job): ExecutionAdapter {
    const adapter = this.adapters.get(job.profileId); if (!adapter) throw new Error("Account profile is unavailable"); return adapter;
  }
  async reconcile(id: string, taskId: string): Promise<Job> {
    const job = this.store.job(id);
    if (job.state !== "submission_unknown" && job.state !== "needs_attention") throw new Error("Only an uncertain or blocked job can be attached to a provider task");
    const adapter = this.adapter(job);
    const taskUrl = adapter.describeTask?.(taskId).taskUrl ?? "";
    await adapter.inspect(taskId, this.context(job));
    return this.store.update(id, { taskId, taskUrl, state: "running", blocker: undefined }, "reconciled", "Explicit provider task identity attached; no resubmission");
  }
  cancel(id: string, acknowledgeUnknown = false): Job {
    const job = this.store.job(id);
    if (["queued","ready","needs_attention"].includes(job.state)) return this.store.update(id, { state: "cancelled" }, "cancelled");
    if (job.state === "submission_unknown") {
      if (!acknowledgeUnknown) throw new Error("This submission is uncertain: investigate with the provider task list, reconcile if a task exists, or cancel with acknowledgeUnknown after confirming none does");
      return this.store.update(id, { state: "cancelled", cancelRequested: true }, "cancelled", "Operator confirmed no provider task exists for this uncertain submission; execution slot released");
    }
    if (job.state === "merged" || job.state === "cancelled") return job;
    return this.store.update(id, { cancelRequested: true }, "cancel_requested", "Native cloud cancellation is unavailable; the provider task may still be running");
  }
  private async keepActivity(job: Job): Promise<void> {
    const adapter = this.adapters.get(job.profileId);
    if (!adapter?.transcript || !job.taskId) return;
    try {
      const transcript = await adapter.transcript(job.taskId);
      if (!transcript.trim()) return;
      const activityArtifact = join(this.artifactDir, `${job.id}.activity.jsonl`); writeFileSync(activityArtifact, transcript, { mode: 0o600 });
      this.store.touch(job.id, { activityArtifact });
    } catch (error) { console.warn(`later.dog kept no progress log for job ${job.id}: ${message(error)}`); }
  }
  private keepTrace(job: Job, capMs = this.options.traceBudgetMs ?? TRACE_BUDGET_MS): Promise<void> {
    const running = this.tracing.get(job.id);
    const work = running ?? this.captureTrace(job, this.options.traceBudgetMs ?? TRACE_BUDGET_MS).finally(() => this.tracing.delete(job.id));
    if (!running) this.tracing.set(job.id, work);
    return settleWithin(work, capMs, "Keeping the trace").catch(() => undefined);
  }
  private async captureTrace(job: Job, budgetMs: number): Promise<void> {
    const adapter = this.adapters.get(job.profileId);
    if (!adapter?.trace || !job.taskId || this.store.job(job.id).trace) return;
    const started = Date.now();
    let reason: string;
    try {
      const captured = await settleWithin(adapter.trace(job.taskId, budgetMs), budgetMs, "Capturing the trace");
      if (!captured) reason = "The computer had no event stream to keep";
      else { await this.storeTrace(job.id, captured, Math.max(budgetMs - (Date.now() - started), 1_000)); return; }
    } catch (error) { reason = message(error); }
    console.warn(`later.dog kept no trace for job ${job.id}: ${reason}`);
    this.store.update(job.id, {}, "trace_not_kept", reason);
  }
  private async storeTrace(jobId: string, captured: TraceCapture, remainingMs: number): Promise<void> {
    const upload = { retentionDays: this.options.traceRetentionDays ?? traceRetentionDays(process.env), truncated: captured.truncated };
    let localFailure: string | undefined;
    try { this.store.touch(jobId, { trace: await this.traces.local.put(jobId, captured.gz, upload) }); }
    catch (error) { localFailure = message(error); }
    if (this.traces.primary.where === "local") {
      if (localFailure) throw new Error(localFailure);
      return;
    }
    if (localFailure === undefined) { this.promoteTrace(jobId, captured.gz, upload); return; }
    try { this.store.touch(jobId, { trace: await settleWithin(this.uploadTrace(jobId, captured.gz, upload), remainingMs, "Uploading the trace") }); }
    catch (error) { throw new Error(`${message(error)}; and the supervisor's own disk refused it: ${localFailure}`); }
  }
  private async uploadTrace(jobId: string, gz: Buffer, upload: { retentionDays: number; truncated: boolean }): Promise<JobTrace> {
    const waits = this.options.traceRetryMs ?? [1_000, 4_000];
    const signal = AbortSignal.timeout(this.options.traceBudgetMs ?? TRACE_BUDGET_MS);
    for (let attempt = 0; ; attempt += 1) {
      try { return await this.traces.primary.put(jobId, gz, { ...upload, signal }); }
      catch (error) {
        if (attempt >= waits.length || signal.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
      }
    }
  }
  private promoteTrace(jobId: string, gz: Buffer, upload: { retentionDays: number; truncated: boolean }): void {
    const run: Promise<void> = this.uploadTrace(jobId, gz, upload)
      .then((trace) => { this.store.touch(jobId, { trace }); this.traces.local.forget(jobId); })
      .catch((error: unknown) => { this.store.update(jobId, {}, "trace_kept_locally", `The trace store refused it (${message(error)}); kept on this supervisor's disk instead`); })
      .finally(() => { this.uploads.delete(run); });
    this.uploads.add(run);
  }
  async trace(id: string): Promise<{ stream: Readable; filename: string; expiresAt: string; truncated: boolean }> {
    const job = this.store.job(id);
    if (!job.trace) throw Object.assign(new Error("No trace was kept for this job."), { status: 404 });
    if (traceExpired(job.trace)) throw Object.assign(new Error(`This job's trace expired ${job.trace.expiresAt.slice(0, 10)}.`), { status: 410 });
    const store = job.trace.where === "local" ? this.traces.local : this.traces.primary;
    const stored = await store.open(id);
    if (!stored) throw Object.assign(new Error("This job's trace is no longer in the store."), { status: 410 });
    return { stream: readableTraceStream(stored), filename: `laterdog-job-${id}-trace.jsonl`, expiresAt: job.trace.expiresAt, truncated: job.trace.truncated };
  }
  private sweepTraces(): void {
    if (Date.now() - this.lastTraceSweep < (this.options.traceSweepMs ?? 3_600_000)) return;
    this.lastTraceSweep = Date.now();
    const keep = new Set(this.store.jobs().filter((job) => job.trace?.where === "local" && !traceExpired(job.trace)).map((job) => job.id));
    try { this.traces.local.sweep(keep); } catch (error) { console.warn(`later.dog could not sweep local traces: ${message(error)}`); }
  }
  private async collect(job: Job): Promise<void> {
    const patch = await this.adapter(job).collect(job.taskId!, this.context(job));
    const patchArtifact = join(this.artifactDir, `${job.id}.patch`); writeFileSync(patchArtifact, patch, { mode: 0o600 });
    const cancelled = this.store.job(job.id).cancelRequested;
    this.store.update(job.id, { state: cancelled ? "cancelled" : "ready", patchArtifact, changes: patchChanges(patch), finishedAt: new Date().toISOString(), blocker: patch.trim() ? undefined : "Cloud task finished without a diff; inspect it before deciding the next step" }, "collected", "Provider diff retained; completion is not verification");
    if (cancelled) return;
    if (job.kind === "review" && job.parentId) {
      const files = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
      if (files.length !== 1 || files[0][2] !== ".laterdog-review.json") throw new Error("Reviewer returned no review manifest or changed files outside review scope");
      const additions = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n");
      const report: unknown = JSON.parse(additions);
      if (!report || typeof report !== "object" || !("headSha" in report) || !("verdict" in report) || !("summary" in report) ||
        typeof report.summary !== "string" || report.summary.length > 50_000 || !["pass", "changes_requested"].includes(String(report.verdict))) throw new Error("Invalid independent review manifest");
      const parent = this.store.job(job.parentId);
      if (report.headSha !== job.baseSha || parent.headSha !== job.baseSha) throw new Error("Review is stale; the parent PR commit changed");
      this.store.update(parent.id, { review: { headSha: job.baseSha!, reviewerJobId: job.id, verdict: report.verdict as "pass" | "changes_requested", summary: report.summary, at: new Date().toISOString() } }, "reviewed", String(report.verdict));
    }
  }
  private async operation<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (this.stopped || !this.store.lease(this.owner)) throw new Error("Another controller owns this workspace");
    if (this.inFlight.has(id)) throw new Error("This job already has an operation in progress");
    const job = this.store.job(id);
    const active = this.store.jobs().filter((other) => activeJob(other) && other.id !== id);
    if (active.length >= this.options.concurrency) throw new Error("All execution slots are occupied; retry after another job settles");
    if (active.some((other) => other.repository === job.repository && (other.outputBranch === job.outputBranch || scopesOverlap(other.writeScopes,job.writeScopes)))) throw new Error("Conflicting repository work is still active");
    this.inFlight.add(id);
    try { return await run(); } finally { this.inFlight.delete(id); }
  }
  async publish(id: string, summary?: string): Promise<Job> { return this.operation(id,() => this.publishResult(id,summary)); }
  private async publishResult(id: string, summary?: string): Promise<Job> {
    this.remote(); const job = this.store.job(id);
    if (job.cancelRequested || job.kind === "review" || !["ready", "needs_attention"].includes(job.state) || !job.patchArtifact) throw new Error("Collect an implementation diff before publishing");
    this.store.update(id, { state: "publishing", blocker: undefined }, "publishing");
    try {
      const result = await this.publisher.publish(job, this.store.repository(job.repository), readFileSync(job.patchArtifact, "utf8"),summary);
      if (job.parentId) this.store.update(job.parentId, { verification: undefined, review: undefined }, "evidence_invalidated", "Correction published a new PR commit");
      return this.store.update(id, { ...result, state: result.merged ? "merged" : "ready" }, "published", result.prUrl);
    } catch (error) { this.store.update(id, { state: "needs_attention", blocker: message(error) }, "publication_blocked"); throw error; }
  }
  async verify(id: string): Promise<Job> { return this.operation(id,() => this.verifyResult(id)); }
  private async verifyResult(id: string): Promise<Job> {
    this.remote(); const job = this.store.job(id);
    if (!["ready","needs_attention"].includes(job.state)) throw new Error("Job must be ready before verification");
    this.store.update(id, { state: "verifying" }, "verifying");
    try {
      const verification = await this.publisher.verify(job, this.store.repository(job.repository), this.artifactDir);
      const changed = job.headSha !== verification.headSha;
      return this.store.update(id, { state: "ready", headSha: verification.headSha, verification, ...(changed ? { review: undefined } : {}),
        blocker: verification.verdict === "passed" ? undefined : `Verification ${verification.verdict}; evidence retained` }, "verified", verification.verdict);
    } catch (error) { this.store.update(id, { state: "ready", blocker: message(error) }, "verification_blocked"); throw error; }
  }
  async merge(id: string): Promise<Job> { return this.operation(id,() => this.mergeResult(id)); }
  private async mergeResult(id: string): Promise<Job> {
    this.remote(); const job = this.store.job(id);
    if (job.state !== "ready" || job.cancelRequested) throw new Error("Settle the active job before merging");
    if (!this.store.repository(job.repository).merge) throw new Error("Merge authority has not been granted for this repository");
    await this.publisher.merge(job);
    return this.store.update(id, { state: "merged" }, "merged", job.prUrl);
  }
  async tick(): Promise<void> {
    if (this.stopped || !this.store.lease(this.owner)) return;
    if (!this.recovered) {
      for (const job of this.store.jobs()) {
        if (job.state === "submitting" && !job.taskId) this.store.update(job.id, { state: "submission_unknown", blocker: "Supervisor restarted during submission; reconcile before retrying" }, "recovered");
        else if (job.state === "collecting") this.store.update(job.id, { state: "running" }, "recovered");
        else if (job.state === "publishing" || job.state === "verifying") this.store.update(job.id, { state: "needs_attention", blocker: "Supervisor restarted during a repository operation; retained checkout and evidence need reconciliation" }, "recovered");
      }
      this.recovered = true;
    }
    if (this.options.publishingHost === "remote" && Date.now() - this.lastHeadCheck > 30_000) {
      this.lastHeadCheck = Date.now();
      const published = this.store.jobs().filter((j) => j.prNumber && j.headSha && !["merged","cancelled"].includes(j.state));
      const window = [...published.slice(this.headCursor), ...published.slice(0,this.headCursor)].slice(0,20);
      this.headCursor = published.length ? (this.headCursor + window.length) % published.length : 0;
      for (const job of window) {
        if (this.inFlight.has(job.id)) continue;
        this.inFlight.add(job.id);
        try {
          const { headSha, state } = await this.publisher.inspectPublished(job);
          if (state === "MERGED") { this.store.update(job.id,{ state: "merged", headSha, ...(headSha !== job.headSha ? { verification: undefined, review: undefined } : {}) },"merged","Observed the merge on GitHub"); continue; }
          if (state === "CLOSED") { const blocker = "The PR was closed on GitHub; decide whether to start new work"; if (job.blocker !== blocker) this.store.update(job.id,{ state: "needs_attention", blocker },"publication_blocked"); continue; }
          if (headSha !== job.headSha) this.store.update(job.id,{ headSha, verification: undefined, review: undefined },"evidence_invalidated","PR head changed; previous verdicts no longer apply");
        } catch {}
        finally { this.inFlight.delete(job.id); }
      }
    }
    const pollInterval = this.options.pollIntervalMs ?? 0;
    for (const job of this.store.jobs().filter((j) => j.state === "running")) {
      if (this.inFlight.has(job.id)) continue;
      const interval = job.backend === "laterdog-cloud" ? Math.min(pollInterval, 10_000) : pollInterval;
      if (interval > 0 && Date.now() - (this.lastPolled.get(job.id) ?? 0) < interval) continue;
      this.lastPolled.set(job.id, Date.now());
      this.inFlight.add(job.id);
      let collecting = false;
      try {
        const adapter = this.adapter(job);
        const state = await adapter.inspect(job.taskId!, this.context(job));
        const seen = adapter.progress?.(job.taskId!);
        if (seen && (seen.stage !== job.stage || JSON.stringify(seen.lastStep) !== JSON.stringify(job.lastStep))) {
          this.store.touch(job.id, { ...(seen.stage ? { stage: seen.stage } : {}), ...(seen.lastStep ? { lastStep: seen.lastStep } : {}) });
        }
        if (state === "failed") {
          this.lastPolled.delete(job.id);
          await this.keepActivity(job);
          await this.keepTrace(job);
          if (this.store.job(job.id).cancelRequested) this.store.update(job.id, { state: "cancelled", finishedAt: new Date().toISOString() }, "cancelled", "Stopped; its computer was deleted");
          else this.store.update(job.id, { state: "needs_attention", finishedAt: new Date().toISOString(), blocker: adapter.failure?.(job.taskId!) ?? "Provider reports this task failed; an agent can investigate and choose a repair" }, "provider_failed");
        }
        else if (state === "ready") {
          this.lastPolled.delete(job.id); collecting = true;
          this.store.update(job.id, { state: "collecting" }, "collecting");
          await this.keepActivity(job);
          await this.keepTrace(job);
          await this.collect(job);
        }
      } catch (error) {
        const blocker = message(error);
        if (collecting) this.store.update(job.id, { state: "needs_attention", blocker }, "collection_blocked");
        else if (this.store.job(job.id).blocker !== blocker) this.store.update(job.id, { blocker }, "poll_failed", "Task identity retained; no duplicate submission");
      } finally { this.inFlight.delete(job.id); }
    }
    for (const job of this.store.jobs().reverse().filter((j) => j.state === "queued" || j.state === "preparing")) {
      if (this.stopped || this.inFlight.has(job.id) || !this.store.lease(this.owner)) continue;
      const jobs = this.store.jobs(); const active = jobs.filter((j) => activeJob(j) && j.id !== job.id);
      const dependency = job.dependencies.map(id => this.store.job(id)).find(other => !["ready","merged"].includes(other.state));
      const conflict = active.find(other => other.repository === job.repository && (other.outputBranch === job.outputBranch || scopesOverlap(other.writeScopes,job.writeScopes)));
      const waiting = dependency ? `Waiting for dependency ${dependency.id} (${dependency.state}); inspect that job before proceeding` : active.length >= this.options.concurrency ? "All configured execution slots are occupied" : conflict ? `Waiting for conflicting writer ${conflict.id} to settle` : undefined;
      if (waiting) { if (job.blocker !== waiting) this.store.update(job.id,{ blocker: waiting },"waiting",waiting); continue; }
      this.inFlight.add(job.id);
      try {
        this.store.update(job.id, { state: "preparing", blocker: undefined }, "preparing");
        const access = await this.adapter(job).doctor?.();
        if (access && !access.authenticated) {
          if (job.backend === "laterdog-cloud") console.warn("[cloud tasks] later.dog Cloud needs CLAUDE_CODE_OAUTH_TOKEN and the computers service (COMPUTERS binding, or LATERDOG_COMPUTERS_URL with LATERDOG_COMPUTERS_KEY) on this supervisor");
          throw new Error(job.backend === "laterdog-cloud"
            ? "Cloud tasks aren't set up on this later.dog yet, so this one can't start. The dog can do it here in the chat instead."
            : "Cloud tasks here run on Codex Cloud, which needs your ChatGPT account. Sign in to ChatGPT in Settings, then try again.");
        }
        const repository = this.store.repository(job.repository);
        const environment = repository.environments[job.backend] ?? (job.backend === "codex-cloud" ? repository.environmentId : job.backend === "laterdog-cloud" ? "auto" : "");
        if (!environment) throw new Error(`${repository.slug} isn't connected to ${job.backend === "codex-cloud" ? "Codex Cloud" : "cloud tasks"} yet. Connect it there, then try again.`);
        const prepared = await this.publisher.prepare(job, repository, job.parentId ? this.store.job(job.parentId) : undefined);
        if (this.stopped || this.store.job(job.id).cancelRequested) {
          this.store.update(job.id,{ ...prepared, state: "cancelled" },"cancelled","Stopped before provider submission"); continue;
        }
        this.store.update(job.id, { ...prepared, state: "submitting" }, "submitting", "Starting ref is pinned; it is not the output branch");
        const delivery = job.backend === "claude-cloud"
          ? "Push only to the branch named in the routine payload and open no pull request; later.dog collects your diff from that branch."
          : job.backend === "laterdog-cloud"
            ? "Leave your changes in this checkout. Do not push, open pull requests, merge, deploy, or access unrelated credentials; later.dog collects your diff from this computer."
            : "Do not push, merge, deploy, or access unrelated credentials. later.dog collects your diff.";
        const prompt = `[later.dog job ${job.id}]\n${job.brief}\n\nStanding instructions:\n${job.standingInstructions}\n\nWrite only these relative path prefixes: ${job.writeScopes.join(", ")}. Verify the real behavior. ${delivery} Report exact checks and limitations.`;
        const submitted = await this.adapter(job).submit(environment, prepared.sourceRef, prompt, this.context({ ...job, ...prepared }));
        this.store.update(job.id, { ...submitted, state: "running", startedAt: new Date().toISOString() }, "submitted", submitted.taskId);
      } catch (error) {
        const uncertain = error instanceof SubmissionUnknown || this.store.job(job.id).state === "submitting";
        this.store.update(job.id, { state: uncertain ? "submission_unknown" : "needs_attention", blocker: message(error) }, uncertain ? "submission_unknown" : "preparation_blocked");
      } finally { this.inFlight.delete(job.id); }
    }
    this.sweepTraces();
    if (this.options.workspaceUrl) await deliverOutbox(this.store,this.options.workspaceUrl,this.options.workspaceTokenFile);
  }
  preferredProfile(account?: string): string {
    const cloud = this.options.profiles.filter((profile) => this.adapters.get(profile.id)?.capabilities.id === "laterdog-cloud");
    const named = account ? cloud.find((profile) => profile.account === account || profile.id === account) : undefined;
    if (named) return named.id;
    for (const [id, adapter] of this.adapters) if (adapter.capabilities.id === "laterdog-cloud") return id;
    return "default";
  }
  private accountLabel(job: Job): string | undefined { return this.options.profiles.find((profile) => profile.id === job.profileId)?.label; }
  summaries(query: { ids?: string[]; botId?: string; limit?: number }): CloudTaskSummary[] {
    const jobs = this.store.jobs();
    if (query.ids) {
      const byId = new Map(jobs.map((job) => [job.id, job]));
      return query.ids.flatMap((id) => { const job = byId.get(id); return job ? [cloudTaskSummary(job, this.accountLabel(job))] : []; });
    }
    return jobs.filter((job) => !query.botId || job.botId === query.botId).slice(0, query.limit ?? 20).map((job) => cloudTaskSummary(job, this.accountLabel(job)));
  }
  async activity(id: string, after: number): Promise<CloudTaskActivityPage> {
    if (!Number.isSafeInteger(after) || after < 0) throw Object.assign(new Error("after must be a byte offset"), { status: 400 });
    const job = this.store.job(id);
    if (job.activityArtifact && existsSync(job.activityArtifact)) {
      const log = readFileSync(job.activityArtifact);
      const start = Math.min(after, log.length);
      const { steps, consumedBytes } = parseCloudTaskSteps(log.subarray(start, start + MAX_ACTIVITY_PAGE_BYTES).toString("utf8"));
      return { steps, cursor: start + consumedBytes, live: false, available: true };
    }
    const adapter = this.adapters.get(job.profileId);
    if (!adapter?.activity) return { steps: [], cursor: after, live: false, available: false, reason: "This backend does not report progress steps." };
    if (!job.taskId) return { steps: [], cursor: after, live: job.state === "queued" || activeJob(job), available: false, reason: job.state === "queued" ? "Waiting to start." : activeJob(job) ? "Starting." : "This task never started." };
    try {
      const page = await adapter.activity(job.taskId, after);
      return job.state === "running" || job.state === "collecting" ? page : { ...page, live: false };
    } catch (error) {
      if (job.state !== "running") return { steps: [], cursor: after, live: false, available: false, reason: "This task's progress log was not kept." };
      throw error;
    }
  }
  async screen(id: string): Promise<{ url: string; expiresAt: number | string }> {
    const job = this.store.job(id);
    const adapter = this.adapters.get(job.profileId);
    if (!adapter?.screen || !job.taskId) throw Object.assign(new Error("This task has no screen to watch."), { status: 409 });
    if (job.state !== "running") throw Object.assign(new Error("A task's computer is only kept while it runs, so there is no screen to watch now."), { status: 409 });
    return adapter.screen(job.taskId);
  }
  async stopJob(id: string, acknowledgeUnknown = false): Promise<Job> {
    const job = this.store.job(id);
    const adapter = this.adapters.get(job.profileId);
    if (job.state !== "running" || !job.taskId || !adapter?.cancel) return this.cancel(id, acknowledgeUnknown);
    this.store.update(id, { cancelRequested: true }, "cancel_requested", "Deleting the task's computer");
    const cap = this.options.traceStopCapMs ?? TRACE_STOP_CAP_MS;
    await Promise.all([settleWithin(this.keepActivity(job), cap, "Keeping the progress log").catch(() => undefined), this.keepTrace(job, cap)]);
    await adapter.cancel(job.taskId);
    if (this.inFlight.has(id)) return this.store.job(id);
    return this.store.update(id, { state: "cancelled", finishedAt: new Date().toISOString() }, "cancelled", "Stopped; its computer was deleted");
  }
  async ensureRepository(request: unknown): Promise<void> {
    const parsed = createJobSchema.safeParse(request);
    if (!parsed.success || this.store.hasRepository(parsed.data.repository)) return;
    if (this.adapters.get(parsed.data.profileId)?.capabilities.id !== "laterdog-cloud") return;
    const baseRef = await this.publisher.defaultBranch(parsed.data.repository);
    this.store.saveRepository(repositorySchema.parse({ slug: parsed.data.repository, environmentId: "none", environments: { "laterdog-cloud": "auto" }, baseRef, publish: true, merge: false }));
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.tracing.values(), ...this.uploads]); while (this.inFlight.size) { this.store.lease(this.owner); await new Promise((resolve) => setTimeout(resolve,20)); } this.store.release(this.owner); }
  stop(): void { this.stopped = true; }
}
export function message(error: unknown): string { return error instanceof Error ? error.message : "Operation failed"; }
export type { CreateJob };
