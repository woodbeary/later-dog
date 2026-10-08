import type { BackendCapabilities, Profile } from "../../shared/laterdog.ts";
import { runCommand, requireOutput, type CommandRunner } from "./command.ts";
import { SubmissionUnknown, type ExecutionAdapter, type JobContext } from "./codex-cloud.ts";

export const CLAUDE_CLOUD_CAPABILITIES: BackendCapabilities = {
  id: "claude-cloud", label: "Claude Code cloud", enabled: true, submission: true, continuation: false, cancellation: false,
  activity: "polled", billing: "subscription",
  limitation: "Sessions start through a routine's API trigger (30 per hour per routine). Claude exposes no session status, result or cancellation API: completion is inferred from the branch the session pushes, and a session that never pushes is reported failed after the timeout. Corrections start a new session.",
};
export const SESSION_ID = /^session_[A-Za-z0-9_-]+$/;
const FIRE_HEADERS = { "anthropic-version": "2023-06-01", "anthropic-beta": "experimental-cc-routine-2026-04-01", "content-type": "application/json" };

export interface ClaudeCloudAdapterOptions {
  fetch?: typeof fetch;
  run?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** How long a session may run without pushing its branch before it is reported failed. */
  timeoutMs?: number;
  cwd?: string;
}

/** The scratch branch a session pushes to; later.dog still publishes from its own isolated checkout, so this is never the PR branch. */
export function sessionBranch(jobId: string): string { return `laterdog/claude/${jobId}`; }

/**
 * Claude Code cloud sessions can only be started headlessly by firing a routine's API trigger, and nothing reports their status.
 * This adapter therefore asks the session (through the routine's saved prompt) to check out the pinned input ref and push its work
 * to a job-specific branch, watches that branch on GitHub to detect completion, and collects the result as the compare diff.
 */
export class ClaudeCloudAdapter implements ExecutionAdapter {
  readonly capabilities = CLAUDE_CLOUD_CAPABILITIES;
  private readonly profile: Profile;
  private readonly fetchImpl: typeof fetch;
  private readonly run: CommandRunner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cwd?: string;
  constructor(profile: Profile, options: ClaudeCloudAdapterOptions = {}) {
    this.profile = profile; this.fetchImpl = options.fetch ?? fetch; this.run = options.run ?? runCommand; this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now; this.timeoutMs = options.timeoutMs ?? 90 * 60_000; this.cwd = options.cwd;
  }
  private token(): string {
    const name = this.profile.routineTokenEnv;
    const value = name ? this.env[name]?.trim() : undefined;
    if (!name || !value) throw new Error(`Routine token environment variable ${name ?? "(routineTokenEnv)"} is not set for profile ${this.profile.id}`);
    return value;
  }
  private async gh(args: string[]) { return this.run("gh", args, { cwd: this.cwd, timeoutMs: 60_000 }); }
  async doctor(): Promise<{ version: string; authenticated: boolean; cloudCommands: string }> {
    let authenticated = false; try { this.token(); authenticated = true; } catch { /* reported as unauthenticated */ }
    return { version: "routines-fire-2026-04-01", authenticated, cloudCommands: "POST /v1/claude_code/routines/{routineId}/fire; completion observed through the pushed branch" };
  }
  describeTask(taskId: string): { taskUrl: string } {
    if (!SESSION_ID.test(taskId)) throw new Error("Invalid Claude session ID");
    return { taskUrl: `https://claude.ai/code/${taskId}` };
  }
  async submit(environmentId: string, sourceRef: string, prompt: string, context?: JobContext) {
    const routineId = environmentId || this.profile.routineId;
    if (!routineId || !/^trig_[A-Za-z0-9_-]+$/.test(routineId)) throw new Error("Configure the repository's claude-cloud routine ID (trig_…) before delegating");
    const jobId = context?.jobId ?? sourceRef.split("/").at(-1) ?? "";
    const text = `${prompt}\n\n[laterdog routine payload]\nref: ${sourceRef}\npush-to: ${sessionBranch(jobId)}\njob: ${jobId}\nFollow the routine's instructions for this payload exactly: check out the ref, do only this work, push only to push-to, open no pull request.`;
    if (text.length > 65_000) throw new Error("The brief exceeds the routine payload limit (65,536 characters)");
    const token = this.token(); // a configuration error must surface as such, not as an uncertain submission
    let response: Response;
    try {
      response = await this.fetchImpl(`https://api.anthropic.com/v1/claude_code/routines/${routineId}/fire`, {
        method: "POST", headers: { ...FIRE_HEADERS, authorization: `Bearer ${token}` }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // The request may have reached Anthropic; there is no idempotency key, so a retry could start a second session.
      throw new SubmissionUnknown();
    }
    if (response.status >= 500) throw new SubmissionUnknown();
    const body = await response.json().catch(() => ({})) as { claude_code_session_id?: string; claude_code_session_url?: string; error?: { message?: string } };
    if (!response.ok) throw new Error(`Routine fire failed (${response.status}): ${body.error?.message ?? "no detail"}${response.status === 429 ? "; the routine's hourly fire limit was reached" : ""}`);
    if (!body.claude_code_session_id || !SESSION_ID.test(body.claude_code_session_id)) throw new SubmissionUnknown();
    return { taskId: body.claude_code_session_id, taskUrl: body.claude_code_session_url ?? `https://claude.ai/code/${body.claude_code_session_id}` };
  }
  async inspect(taskId: string, context?: JobContext): Promise<"running" | "ready" | "failed"> {
    if (!SESSION_ID.test(taskId)) throw new Error("Invalid Claude session ID");
    if (!context) throw new Error("Claude cloud inspection needs the job context (repository and job ID)");
    const result = await this.gh(["api", `repos/${context.repository}/branches/${sessionBranch(context.jobId)}`]);
    if (result.exitCode === 0) {
      const branch = JSON.parse(result.stdout) as { commit?: { sha?: string } };
      if (branch.commit?.sha && branch.commit.sha !== context.baseSha) return "ready";
    } else if (!/404/.test(result.stderr + result.stdout)) throw new Error(`Could not inspect the session branch: ${(result.stderr || result.stdout).trim().slice(-300)}`);
    if (this.now() - Date.parse(context.createdAt) > this.timeoutMs) return "failed";
    return "running";
  }
  async collect(taskId: string, context?: JobContext): Promise<string> {
    if (!SESSION_ID.test(taskId)) throw new Error("Invalid Claude session ID");
    if (!context?.baseSha) throw new Error("Claude cloud collection needs the job's pinned starting commit");
    const patch = requireOutput(await this.gh(["api", "-H", "Accept: application/vnd.github.diff", `repos/${context.repository}/compare/${context.baseSha}...${sessionBranch(context.jobId)}`]), "Session diff collection");
    if (!patch.trim()) return "";
    return patch.endsWith("\n") ? patch : `${patch}\n`;
  }
  async list(): Promise<unknown> {
    return { tasks: [], limitation: "Claude exposes no session list API; inspect routine runs at https://claude.ai/code/routines" };
  }
}
