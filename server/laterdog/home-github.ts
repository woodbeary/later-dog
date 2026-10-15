import { describeFailure, runCommand, type CommandResult, type CommandRunner } from "./command.ts";
import { GitHubDeviceLogin, githubCliEnv, type GitHubSignIn } from "./github-login.ts";

export const GITHUB_HOST = "github.com";
export const GITHUB_CREDENTIAL_KEY = "credential.https://github.com.helper";
export const GH_NOT_SIGNED_IN_EXIT = 4;
export const KNOWN_GITHUB_MAX_AGE_MS = 10 * 60_000;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface HomeGitHubStatus {
  login: string | null;
  signIn: GitHubSignIn;
  detail?: string;
}

export type KnownGitHub = { state: "connected"; login: string } | { state: "disconnected" } | { state: "unknown" };

export type HomeGitHubSignIn = Pick<GitHubDeviceLogin, "start" | "status" | "cancel">;

export interface HomeGitHubOptions {
  signIn?: HomeGitHubSignIn;
  run?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

const unstarted = (error: unknown): CommandResult => ({ exitCode: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false });

export class HomeGitHub {
  private readonly signIn: HomeGitHubSignIn;
  private readonly run: CommandRunner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private known: { value: KnownGitHub; at: number } | undefined;
  private checking: Promise<{ login: string | null; detail?: string }> | undefined;
  constructor(options: HomeGitHubOptions = {}) {
    this.env = githubCliEnv(options.env ?? process.env);
    this.run = options.run ?? runCommand;
    this.now = options.now ?? Date.now;
    this.signIn = options.signIn ?? new GitHubDeviceLogin({ env: this.env, run: this.run, tokenInConfigFile: true });
  }

  private gh(args: string[], timeoutMs: number): Promise<CommandResult> {
    return this.run("gh", args, { env: this.env, timeoutMs }).catch(unstarted);
  }

  async account(): Promise<{ login: string | null; detail?: string }> {
    const result = await this.gh(["api", "user", "--jq", ".login"], 20_000);
    const login = result.stdout.trim();
    if (result.exitCode === 0 && !result.timedOut && GITHUB_LOGIN.test(login)) return this.remember({ state: "connected", login }, { login });
    if (result.exitCode === GH_NOT_SIGNED_IN_EXIT && !result.timedOut) return this.remember({ state: "disconnected" }, { login: null });
    return this.remember({ state: "unknown" }, { login: null, detail: describeFailure(result, "Checking GitHub") });
  }

  private remember<T>(value: KnownGitHub, answer: T): T {
    this.known = { value, at: this.now() };
    return answer;
  }

  lastKnown(maxAgeMs = KNOWN_GITHUB_MAX_AGE_MS): KnownGitHub {
    const known = this.known;
    if ((!known || this.now() - known.at > maxAgeMs) && !this.checking) {
      this.checking = this.account().finally(() => { this.checking = undefined; });
      this.checking.catch(() => {});
    }
    return known?.value ?? { state: "unknown" };
  }

  async status(): Promise<HomeGitHubStatus> {
    const signIn = this.signIn.status();
    const { login, detail } = await this.account();
    return { login, signIn, ...(detail ? { detail } : {}) };
  }

  async connect(): Promise<HomeGitHubStatus> {
    await this.signIn.start();
    return this.status();
  }

  async disconnect(): Promise<HomeGitHubStatus> {
    this.signIn.cancel();
    const result = await this.gh(["auth", "logout", "--hostname", GITHUB_HOST], 30_000);
    if ((result.exitCode !== 0 || result.timedOut) && !/not logged in/i.test(`${result.stderr}\n${result.stdout}`)) {
      throw new Error(describeFailure(result, "Disconnecting GitHub"));
    }
    await this.run("git", ["config", "--global", "--unset-all", GITHUB_CREDENTIAL_KEY], { env: this.env, timeoutMs: 15_000 }).catch(unstarted);
    return this.status();
  }
}
