import { spawn, type ChildProcess } from "node:child_process";
import { runCommand, type CommandRunner } from "./command.ts";
import type { LoginSpawner } from "./codex-cloud.ts";

/** Where a GitHub sign-in started from this host stands. The token gh receives never leaves gh's own config. */
export interface GitHubSignIn {
  phase: "idle" | "waiting" | "done" | "failed";
  /** The one-time code and the page to enter it on, while waiting. */
  code?: string;
  url?: string;
  startedAt?: string;
  detail?: string;
}

/** gh's non-interactive device flow prints "! First copy your one-time code: ABCD-1234" and the page to open. */
export function parseGitHubDevicePrompt(output: string): { code: string; url: string } | null {
  const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(output)?.[1];
  const url = /(https:\/\/github\.com\/login\/device)\b/.exec(output)?.[1];
  return code && url ? { code, url } : null;
}

export interface GitHubDeviceLoginOptions {
  spawner?: LoginSpawner;
  run?: CommandRunner;
  /** How long to wait for gh to print its code. */
  promptMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Signs gh in on the host the supervisor runs on (a Cloudflare container has no shell to do it from) with GitHub's own
 * device flow: the operator opens github.com/login/device, enters the code and authorizes. The resulting credential lives
 * in gh's config on that host; the entrypoint backs it up encrypted, and `gh auth setup-git` lets plain git push with it.
 * Nobody copies or pastes a token. The `workflow` scope is requested because published branches may change workflows.
 */
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
    // gh refuses to store a login while GH_TOKEN is set, and a stale token must not shadow the new one.
    const { GH_TOKEN: _gh, GITHUB_TOKEN: _github, ...env } = options.env ?? process.env;
    this.env = { ...env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
  }
  status(): GitHubSignIn { return this.flow ? { ...this.flow.status } : { phase: "idle" }; }
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
    // Plain git (fetch, push from the isolated checkout) authenticates through gh once this is set up.
    const setup = await this.run("gh", ["auth", "setup-git"], { env: this.env, timeoutMs: 30_000 }).catch((error: unknown) => ({ exitCode: 1, stdout: "", stderr: String(error), timedOut: false }));
    flow.status = setup.exitCode === 0
      ? { phase: "done", startedAt: flow.status.startedAt }
      : { phase: "done", startedAt: flow.status.startedAt, detail: "Signed in, but gh auth setup-git failed; git push may lack credentials until the supervisor restarts." };
  }
}
