import { spawn, type ChildProcess } from "node:child_process";
import type { BackendCapabilities, Profile } from "../../shared/laterdog.ts";
import { describeFailure, runCommand, requireOutput, requireSuccess, type CommandRunner } from "./command.ts";

export const CODEX_CLOUD_CAPABILITIES: BackendCapabilities = {
  id: "codex-cloud", label: "Codex Cloud", enabled: true, submission: true, continuation: false, cancellation: false,
  activity: "polled", billing: "subscription", limitation: "Environment setup uses Codex desktop/web. Corrections start a new cloud run. Native cancellation is not exposed by this CLI. Task status is polled from PENDING/READY/APPLIED/ERROR labels.",
};
export interface CodexCloudAdapterOptions {
  /** Working directory for CLI calls. The CLI writes error.log into its cwd, which must be writable (the container's /app is not). */
  cwd?: string;
  /** Process spawner for the long-running device login (tests inject a fake). */
  spawner?: LoginSpawner;
  /** How long to wait for the login command to print its verification URL and code. */
  loginPromptMs?: number;
}
export interface LoginStart { started: boolean; instructions: string; startedAt: string }
/** What the supervisor knows about a job at every adapter call; backends without a task API (Claude cloud) observe the repository instead. */
export interface JobContext { jobId: string; repository: string; sourceRef?: string; baseSha?: string; createdAt: string }
export interface ExecutionAdapter {
  capabilities: BackendCapabilities;
  submit(environmentId: string, sourceRef: string, prompt: string, context?: JobContext): Promise<{ taskId: string; taskUrl: string }>;
  inspect(taskId: string, context?: JobContext): Promise<"running" | "ready" | "failed">;
  collect(taskId: string, context?: JobContext): Promise<string>;
  list(): Promise<unknown>;
  /** Validate a provider task identity for this backend and return where an operator can inspect it. */
  describeTask?(taskId: string): { taskUrl: string };
  doctor?(): Promise<{ version: string; authenticated: boolean; cloudCommands: string }>;
  /** Start the provider's headless login and return what the operator must do (a URL and a code); the login keeps running in the background. */
  login?(): Promise<LoginStart>;
}
export type LoginSpawner = (binary: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string }) => ChildProcess;
const TASK_ID = /^task_[a-zA-Z0-9_-]+$/;
export class SubmissionUnknown extends Error { constructor() { super("Cloud submission outcome is uncertain. Reconcile the provider task before any retry."); } }
export class CodexCloudAdapter implements ExecutionAdapter {
  readonly capabilities = CODEX_CLOUD_CAPABILITIES;
  private readonly env: NodeJS.ProcessEnv;
  private readonly profile: Profile;
  private readonly run: CommandRunner;
  private readonly cwd?: string;
  private readonly spawner: LoginSpawner;
  private readonly loginPromptMs: number;
  private loginRun?: { child: ChildProcess; output: string; startedAt: string };
  constructor(profile: Profile, run: CommandRunner = runCommand, options: CodexCloudAdapterOptions = {}) {
    this.profile = profile; this.run = run; this.cwd = options.cwd;
    this.spawner = options.spawner ?? ((binary, args, spawnOptions) => spawn(binary, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"], shell: false }));
    this.loginPromptMs = options.loginPromptMs ?? 15_000;
    this.env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT", "APPDATA", "USERPROFILE", "CODEX_HOME"].includes(key)));
    if (profile.codexHome) this.env.CODEX_HOME = profile.codexHome;
  }
  private async command(args: string[]) { return this.run(this.profile.cli ?? "codex", args, { env: this.env, cwd: this.cwd, timeoutMs: 60_000 }); }
  async doctor(): Promise<{ version: string; authenticated: boolean; cloudCommands: string }> {
    const version = requireSuccess(await this.command(["--version"]), "Codex version check");
    const auth = await this.command(["login", "status"]);
    const cloudCommands = requireSuccess(await this.command(["cloud", "--help"]), "Codex cloud capability check");
    return { version, authenticated: auth.exitCode === 0 && /ChatGPT/i.test(auth.stdout + auth.stderr), cloudCommands };
  }
  describeTask(taskId: string): { taskUrl: string } {
    if (!TASK_ID.test(taskId)) throw new Error("Invalid Codex task ID");
    return { taskUrl: `https://chatgpt.com/codex/tasks/${taskId}` };
  }
  async submit(environmentId: string, sourceRef: string, prompt: string) {
    const result = await this.command(["cloud", "exec", "--env", environmentId, "--branch", sourceRef, "--attempts", "1", prompt]);
    const id = /\b(task_[a-zA-Z0-9_-]+)\b/.exec(result.stdout)?.[1];
    if (!id) throw new SubmissionUnknown();
    return { taskId: id, taskUrl: `https://chatgpt.com/codex/tasks/${id}` };
  }
  async inspect(taskId: string): Promise<"running" | "ready" | "failed"> {
    if (!TASK_ID.test(taskId)) throw new Error("Invalid Codex task ID");
    const result = await this.command(["cloud", "status", taskId]);
    // codex-cli 0.154.0 prints "[PENDING]", "[READY]", "[APPLIED]" or "[ERROR]"; RUNNING/FAILED are kept for older or newer builds.
    // It exits 1 while a task is still pending (observed live on 2026-10-08) and 0 once it is ready, so the exit code alone is
    // not a failed read: the printed label decides, and only output without a label is an error.
    const status = result.timedOut ? undefined : /^\[(READY|APPLIED|PENDING|RUNNING|FAILED|ERROR)\]/im.exec(result.stdout)?.[1];
    if (status === "READY" || status === "APPLIED") return "ready";
    if (status === "FAILED" || status === "ERROR") return "failed";
    if (status === "PENDING" || status === "RUNNING") return "running";
    if (result.exitCode !== 0 || result.timedOut) throw new Error(describeFailure(result, "Cloud status read"));
    throw new Error("Unrecognized Codex cloud status format; retain the task and qualify this CLI version");
  }
  async collect(taskId: string): Promise<string> {
    if (!TASK_ID.test(taskId)) throw new Error("Invalid Codex task ID");
    const result = await this.command(["cloud", "diff", taskId]);
    // A finished task that changed nothing makes the CLI exit with "No diff available"; that is an empty result, not a collection failure.
    if (/No diff available/i.test(result.stdout + result.stderr)) return "";
    const patch = requireOutput(result, "Cloud diff collection");
    if (!patch.trim()) return "";
    return patch.endsWith("\n") ? patch : `${patch}\n`;
  }
  async list(): Promise<unknown> { return JSON.parse(requireSuccess(await this.command(["cloud", "list", "--json", "--limit", "20"]), "Cloud task listing")); }
  /**
   * `codex login --device-auth` (hidden from --help in 0.154.0, but accepted) prints a verification URL and a one-time code, then waits
   * for the operator to confirm in a browser before writing auth.json. The process is left running in the background; this returns
   * the printed instructions so a remote supervisor can be signed in without a shell. A login already in progress is reported, not duplicated.
   */
  async login(): Promise<LoginStart> {
    if (this.loginRun && this.loginRun.child.exitCode === null && !this.loginRun.child.killed) {
      return { started: false, instructions: this.loginRun.output.trim() || "A login is already in progress; wait for its prompt", startedAt: this.loginRun.startedAt };
    }
    const child = this.spawner(this.profile.cli ?? "codex", ["login", "--device-auth"], { env: this.env, cwd: this.cwd });
    const run = { child, output: "", startedAt: new Date().toISOString() }; this.loginRun = run;
    const capture = (chunk: Buffer | string) => { if (run.output.length < 4000) run.output += chunk.toString(); };
    child.stdout?.on("data", capture); child.stderr?.on("data", capture);
    child.on("error", (error) => { run.output += `\n${error.message}`; });
    child.unref?.();
    const prompted = () => /https?:\/\/\S+/.test(run.output) && /\b[A-Z0-9]{4,}-?[A-Z0-9]{4,}\b/.test(run.output);
    const deadline = Date.now() + this.loginPromptMs;
    while (!prompted() && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    if (child.exitCode !== null && !prompted()) throw new Error(`Codex login exited (${child.exitCode}) before printing a device prompt: ${run.output.trim().slice(-400)}`);
    return { started: true, instructions: run.output.trim() || "Codex printed no prompt yet; call again to read it", startedAt: run.startedAt };
  }
}
