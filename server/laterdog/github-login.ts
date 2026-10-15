import { spawn, type ChildProcess } from "node:child_process";
import { runCommand, type CommandRunner } from "./command.ts";
import type { LoginSpawner } from "./codex-cloud.ts";

export interface GitHubSignIn {
  phase: "idle" | "waiting" | "done" | "failed";
  code?: string;
  url?: string;
  startedAt?: string;
  detail?: string;
}

export function parseGitHubDevicePrompt(output: string): { code: string; url: string } | null {
  const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(output)?.[1];
  const url = /(https:\/\/github\.com\/login\/device)\b/.exec(output)?.[1];
  return code && url ? { code, url } : null;
}

export function githubCliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { GH_TOKEN: _gh, GITHUB_TOKEN: _github, ...rest } = env;
  return { ...rest, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
}

export interface GitHubDeviceLoginOptions {
  spawner?: LoginSpawner;
  run?: CommandRunner;
  promptMs?: number;
  env?: NodeJS.ProcessEnv;
}

export class GitHubDeviceLogin {
  private flow?: { child: ChildProcess; output: string; status: GitHubSignIn };
  private readonly spawner: LoginSpawner;
  private readonly run: CommandRunner;
  private readonly promptMs: number;
  private readonly env: NodeJS.ProcessEnv;
  constructor(options: GitHubDeviceLoginOptions = {}) {
    this.spawner = options.spawner ?? ((binary, args, spawnOptions) => spawn(binary, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"], shell: false }));
    this.run = options.run ?? runCommand;
    this.promptMs = options.promptMs ?? 20_000;
    this.env = githubCliEnv(options.env ?? process.env);
  }
  status(): GitHubSignIn { return this.flow ? { ...this.flow.status } : { phase: "idle" }; }
  cancel(): void {
    const flow = this.flow;
    this.flow = undefined;
    if (flow && flow.child.exitCode === null && !flow.child.killed) flow.child.kill("SIGTERM");
  }
  async start(): Promise<GitHubSignIn> {
    if (this.flow?.status.phase === "waiting" && this.flow.child.exitCode === null && !this.flow.child.killed) return this.status();
    const child = this.spawner("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--scopes", "workflow"], { env: this.env });
    const flow = { child, output: "", status: { phase: "waiting", startedAt: new Date().toISOString() } as GitHubSignIn };
    this.flow = flow;
    const capture = (chunk: Buffer | string) => {
      if (flow.output.length < 8000) flow.output += chunk.toString();
      const prompt = parseGitHubDevicePrompt(flow.output);
      if (prompt && !flow.status.code) flow.status = { ...flow.status, ...prompt };
    };
    child.stdout?.on("data", capture); child.stderr?.on("data", capture);
    child.on("error", (error) => { flow.status = { phase: "failed", startedAt: flow.status.startedAt, detail: `gh could not start: ${error.message}` }; });
    child.on("exit", (code) => { void this.finish(flow, code); });
    child.unref?.();
    const deadline = Date.now() + this.promptMs;
    while (!flow.status.code && flow.status.phase === "waiting" && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    if (!flow.status.code && flow.status.phase === "waiting") {
      flow.status = { phase: "failed", startedAt: flow.status.startedAt, detail: `gh printed no sign-in code: ${flow.output.trim().slice(-400) || "no output"}` };
    }
    return this.status();
  }
  private async finish(flow: NonNullable<GitHubDeviceLogin["flow"]>, code: number | null): Promise<void> {
    if (this.flow !== flow || flow.status.phase !== "waiting") return;
    if (code !== 0) {
      flow.status = { phase: "failed", startedAt: flow.status.startedAt, detail: `GitHub sign-in did not finish (gh exited ${code}): ${flow.output.trim().slice(-300)}` };
      return;
    }
    const setup = await this.run("gh", ["auth", "setup-git"], { env: this.env, timeoutMs: 30_000 }).catch((error: unknown) => ({ exitCode: 1, stdout: "", stderr: String(error), timedOut: false }));
    flow.status = setup.exitCode === 0
      ? { phase: "done", startedAt: flow.status.startedAt }
      : { phase: "done", startedAt: flow.status.startedAt, detail: "Signed in, but gh auth setup-git failed; git push may lack credentials until the supervisor restarts." };
  }
}
