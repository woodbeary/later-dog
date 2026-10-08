import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeJob, createJobSchema, scopesOverlap, type BackendId, type CreateJob, type Job, type Profile, type WorkspaceSnapshot } from "../../shared/laterdog.ts";
import { CodexCloudAdapter, SubmissionUnknown, type ExecutionAdapter, type JobContext } from "./codex-cloud.ts";
import { ClaudeCloudAdapter, CLAUDE_CLOUD_CAPABILITIES } from "./claude-cloud.ts";
import { GitHubPublisher } from "./github.ts";
import { GitHubDeviceLogin } from "./github-login.ts";
import { WorkspaceStore } from "./store.ts";
import { measuredOutcomes } from "./observations.ts";
import { deliverOutbox } from "./notifications.ts";

export interface SupervisorOptions {
  dataDir: string;
  profiles: Profile[];
  concurrency: number;
  publishingHost: "local" | "remote";
  /** Minimum spacing between provider status polls per running job; 0 polls on every tick (fixtures). Production config defaults to 30 s. */
  pollIntervalMs?: number;
  adapter?: (profile: Profile) => ExecutionAdapter;
  publisher?: GitHubPublisher;
  githubLogin?: GitHubDeviceLogin;
  workspaceUrl?: string;
  workspaceTokenFile?: string;
}

/** A correction's own title, which becomes its commit message on the PR: "Correct: " and the brief's first sentence. */
export function correctionTitle(brief: string): string {
  const first = brief.trim().split(/(?<=[.!?])\s|\n/)[0]?.trim() ?? "";
  const line = first.length > 120 ? `${first.slice(0, 119).trimEnd()}…` : first;
  return `Correct: ${line || "address the review"}`;
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
  readonly store: WorkspaceStore;
  readonly options: SupervisorOptions;
  constructor(store: WorkspaceStore, options: SupervisorOptions) {
    this.store = store; this.options = options;
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 100) throw new Error("Concurrency must be 1–100");
    this.artifactDir = join(options.dataDir, "artifacts"); mkdirSync(this.artifactDir, { recursive: true, mode: 0o700 });
    this.publisher = options.publisher ?? new GitHubPublisher(join(options.dataDir, "checkouts"));
    this.githubLogin = options.githubLogin ?? new GitHubDeviceLogin();
    for (const profile of options.profiles) this.adapters.set(profile.id, options.adapter?.(profile) ?? (profile.backend === "claude-cloud"
      ? new ClaudeCloudAdapter(profile, { cwd: options.dataDir }) : new CodexCloudAdapter(profile, undefined, { cwd: options.dataDir })));
  }
  private context(job: Job): JobContext {
    return { jobId: job.id, repository: job.repository, sourceRef: job.sourceRef, baseSha: job.baseSha, createdAt: job.createdAt };
  }
  create(input: unknown): Job {
    const request = createJobSchema.parse(input);
    const adapter = this.adapters.get(request.profileId); if (!adapter) throw new Error("Unknown account profile");
    return this.store.create(request, adapter.capabilities.id as BackendId);
  }
  /** A repair run against the parent's PR. `writeScopes` replaces the parent's paths when the evidence puts the fix elsewhere. */
  correction(id: string, brief: string, requestKey: string, writeScopes?: string[]): Job {
    const parent = this.store.job(id);
    if (parent.state === "merged" || parent.state === "cancelled") throw new Error("Create a new implementation job after the parent PR has shipped or been cancelled");
    if (!parent.prUrl || !parent.headSha) throw new Error("Publish the result branch before requesting a correction");
    return this.create({ requestKey, repository: parent.repository, title: correctionTitle(brief), brief,
      standingInstructions: parent.standingInstructions, writeScopes: writeScopes ?? parent.writeScopes, dependencies: [id],
      profileId: parent.profileId, kind: "repair", parentId: id, conversationId: parent.conversationId, botId: parent.botId });
  }
  review(id: string, requestKey: string, profileId?: string): Job {
    const parent = this.store.job(id);
    if (!parent.headSha || !parent.prUrl) throw new Error("Publish the result before requesting independent review");
    const brief = `Independently review PR ${parent.prUrl} at commit ${parent.headSha}. Read the change, requirements, tests and relevant surrounding code. Do not edit product code. Write one new root file .laterdog-review.json with JSON: {"headSha":"${parent.headSha}","verdict":"pass" or "changes_requested","summary":"concrete findings and what you actually checked"}. This file is collected as review evidence and is not published to the product branch.\n\nRequirements:\n${parent.brief}`;
    return this.create({ requestKey, repository: parent.repository, title: `Review: ${parent.title}`, brief, standingInstructions: parent.standingInstructions,
      writeScopes: [".laterdog-review.json"], dependencies: [id], profileId: profileId ?? parent.profileId, kind: "review", parentId: id, conversationId: parent.conversationId, botId: parent.botId });
  }
  snapshot(): WorkspaceSnapshot {
    // Jobs come newest first; a PR's jobs (its implementation and any corrections) are grouped, and the newest one's head
    // is the PR's current head. Verification is recorded on the implementation job, so any job of the PR can carry it.
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
  /** One row per configured backend (deduplicated across profiles), then the backends that exist as design only, each with its truthful limitation. */
  private backends(): WorkspaceSnapshot["backends"] {
    const configured = new Map<string, WorkspaceSnapshot["backends"][number]>();
    for (const adapter of this.adapters.values()) configured.set(adapter.capabilities.id, adapter.capabilities);
    if (!configured.has(CLAUDE_CLOUD_CAPABILITIES.id)) configured.set(CLAUDE_CLOUD_CAPABILITIES.id, { ...CLAUDE_CLOUD_CAPABILITIES, enabled: false, limitation: `Add an account profile with backend "claude-cloud", a routine token environment variable and a per-repository routine ID to enable it. ${CLAUDE_CLOUD_CAPABILITIES.limitation}` });
    return [...configured.values(),
      { id: "cursor-cloud", label: "Cursor Cloud", enabled: false, submission: false, continuation: false, cancellation: false, activity: "polled", billing: "api-and-compute", limitation: "Adapter workflow is not yet qualified. Conversation providers remain available independently." },
      { id: "cloudflare-sandbox", label: "Cloudflare sandbox runner", enabled: false, submission: false, continuation: false, cancellation: false, activity: "streamed", billing: "api-and-compute", limitation: "Hosting the supervisor on Cloudflare is supported; running agents inside Cloudflare sandboxes is not, because only API-key billing is documented there and subscription authentication inside a sandbox is unqualified. No paid fallback is enabled." },
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
  /** GitHub access as publishing will use it on this host; a hosted supervisor without `GH_TOKEN` cannot open pull requests. */
  /** GitHub access as publishing will use it on this host, plus any device sign-in in progress. */
  async inspectGitHub() { return { ...await this.publisher.access(), signIn: this.githubLogin.status() }; }
  /** Starts GitHub's device flow on this host; the operator enters the returned code at github.com/login/device. */
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
      // An uncertain submission holds an execution slot forever unless an operator confirms no provider task exists for it.
      if (!acknowledgeUnknown) throw new Error("This submission is uncertain: investigate with the provider task list, reconcile if a task exists, or cancel with acknowledgeUnknown after confirming none does");
      return this.store.update(id, { state: "cancelled", cancelRequested: true }, "cancelled", "Operator confirmed no provider task exists for this uncertain submission; execution slot released");
    }
    if (job.state === "merged" || job.state === "cancelled") return job;
    return this.store.update(id, { cancelRequested: true }, "cancel_requested", "Native cloud cancellation is unavailable; the provider task may still be running");
  }
  private async collect(job: Job): Promise<void> {
    const patch = await this.adapter(job).collect(job.taskId!, this.context(job));
    const patchArtifact = join(this.artifactDir, `${job.id}.patch`); writeFileSync(patchArtifact, patch, { mode: 0o600 });
    const cancelled = this.store.job(job.id).cancelRequested;
    this.store.update(job.id, { state: cancelled ? "cancelled" : "ready", patchArtifact, blocker: patch.trim() ? undefined : "Cloud task finished without a diff; inspect it before deciding the next step" }, "collected", "Provider diff retained; completion is not verification");
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
        } catch { /* An unavailable GitHub connection cannot replace a recorded verdict. Merge checks the live head again. */ }
        finally { this.inFlight.delete(job.id); }
      }
    }
    const pollInterval = this.options.pollIntervalMs ?? 0;
    for (const job of this.store.jobs().filter((j) => j.state === "running")) {
      if (this.inFlight.has(job.id)) continue;
      if (pollInterval > 0 && Date.now() - (this.lastPolled.get(job.id) ?? 0) < pollInterval) continue;
      this.lastPolled.set(job.id, Date.now());
      this.inFlight.add(job.id);
      // A failed status read is the provider not answering yet: the task keeps its identity and is read again. Only a failure
      // while collecting (a diff that cannot be retrieved, a review manifest that does not hold) stops the job.
      let collecting = false;
      try {
        const state = await this.adapter(job).inspect(job.taskId!, this.context(job));
        if (state === "failed") { this.lastPolled.delete(job.id); this.store.update(job.id, { state: "needs_attention", blocker: "Provider reports this task failed; an agent can investigate and choose a repair" }, "provider_failed"); }
        else if (state === "ready") {
          this.lastPolled.delete(job.id); collecting = true;
          this.store.update(job.id, { state: "collecting" }, "collecting"); await this.collect(job);
        }
      } catch (error) {
        const blocker = message(error);
        if (collecting) this.store.update(job.id, { state: "needs_attention", blocker }, "collection_blocked");
        // The same transient error on every poll would flood the event log and the outbox; record it once until it changes.
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
        if (access && !access.authenticated) throw new Error("Sign this native Codex profile in with its supported subscription before submitting cloud work");
        // Resolve the backend's environment before pinning an input ref so a misconfigured repository blocks preparation, not submission.
        const repository = this.store.repository(job.repository);
        const environment = repository.environments[job.backend] ?? (job.backend === "codex-cloud" ? repository.environmentId : "");
        if (!environment) throw new Error(`No ${job.backend} environment is configured for ${repository.slug}; connect one before delegating`);
        const prepared = await this.publisher.prepare(job, repository, job.parentId ? this.store.job(job.parentId) : undefined);
        if (this.stopped || this.store.job(job.id).cancelRequested) {
          this.store.update(job.id,{ ...prepared, state: "cancelled" },"cancelled","Stopped before provider submission"); continue;
        }
        this.store.update(job.id, { ...prepared, state: "submitting" }, "submitting", "Starting ref is pinned; it is not the output branch");
        const delivery = job.backend === "claude-cloud"
          ? "Push only to the branch named in the routine payload and open no pull request; later.dog collects your diff from that branch."
          : "Do not push, merge, deploy, or access unrelated credentials. later.dog collects your diff.";
        const prompt = `[later.dog job ${job.id}]\n${job.brief}\n\nStanding instructions:\n${job.standingInstructions}\n\nWrite only these relative path prefixes: ${job.writeScopes.join(", ")}. Verify the real behavior. ${delivery} Report exact checks and limitations.`;
        const submitted = await this.adapter(job).submit(environment, prepared.sourceRef, prompt, this.context({ ...job, ...prepared }));
        this.store.update(job.id, { ...submitted, state: "running" }, "submitted", submitted.taskId);
      } catch (error) {
        const uncertain = error instanceof SubmissionUnknown || this.store.job(job.id).state === "submitting";
        this.store.update(job.id, { state: uncertain ? "submission_unknown" : "needs_attention", blocker: message(error) }, uncertain ? "submission_unknown" : "preparation_blocked");
      } finally { this.inFlight.delete(job.id); }
    }
    if (this.options.workspaceUrl) await deliverOutbox(this.store,this.options.workspaceUrl,this.options.workspaceTokenFile);
  }
  async drain(): Promise<void> { while (this.inFlight.size) { this.store.lease(this.owner); await new Promise((resolve) => setTimeout(resolve,20)); } this.store.release(this.owner); }
  stop(): void { this.stopped = true; }
}
export function message(error: unknown): string { return error instanceof Error ? error.message : "Operation failed"; }
export type { CreateJob };
