import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { CommandOptions, CommandResult } from "./command.ts";
import { GitHubDeviceLogin, type GitHubSignIn } from "./github-login.ts";
import { GH_NOT_SIGNED_IN_EXIT, HomeGitHub } from "./home-github.ts";

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
const failed = (exitCode: number, stderr: string): CommandResult => ({ exitCode, stdout: "", stderr, timedOut: false });
const PROMPT = "! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n";

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; killed: boolean; unref: () => void; kill: (signal?: string) => boolean };
function fakeChild(): FakeChild {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null as number | null, killed: false, unref: () => {} }) as FakeChild;
  child.kill = vi.fn(() => { child.killed = true; return true; });
  return child;
}

function ghScript(answers: Record<string, () => CommandResult>) {
  const calls: { args: string[]; options?: CommandOptions }[] = [];
  const run = vi.fn(async (binary: string, args: string[], options?: CommandOptions) => {
    expect(binary).toBe("gh");
    calls.push({ args, options });
    const answer = answers[args.join(" ")];
    if (!answer) throw new Error(`unexpected gh ${args.join(" ")}`);
    return answer();
  });
  return { run, calls };
}

function idleSignIn() {
  return { start: vi.fn(async (): Promise<GitHubSignIn> => ({ phase: "waiting", code: "AB12-CD34", url: "https://github.com/login/device" })), status: vi.fn((): GitHubSignIn => ({ phase: "idle" })), cancel: vi.fn() };
}

describe("GitHub on a Cloud home", () => {
  it("shows the signed-in GitHub login, asking gh without any token from the environment", async () => {
    const { run, calls } = ghScript({ "api user --jq .login": () => ok("octocat\n") });
    const github = new HomeGitHub({ run, signIn: idleSignIn(), env: { HOME: "/data", GH_TOKEN: "stale", GITHUB_TOKEN: "stale" } });
    expect(await github.status()).toEqual({ login: "octocat", signIn: { phase: "idle" } });
    expect(calls[0]!.options?.env).toMatchObject({ HOME: "/data", GH_PROMPT_DISABLED: "1" });
    expect(calls[0]!.options?.env?.GH_TOKEN).toBeUndefined();
    expect(calls[0]!.options?.env?.GITHUB_TOKEN).toBeUndefined();
  });

  it("is simply not connected when gh says nobody is signed in", async () => {
    const { run } = ghScript({ "api user --jq .login": () => failed(GH_NOT_SIGNED_IN_EXIT, "To get started with GitHub CLI, please run:  gh auth login") });
    expect(await new HomeGitHub({ run, signIn: idleSignIn(), env: {} }).status()).toEqual({ login: null, signIn: { phase: "idle" } });
  });

  it("says why when GitHub cannot be checked, rather than claiming it is not connected", async () => {
    const { run } = ghScript({ "api user --jq .login": () => failed(1, "HTTP 401: Bad credentials (https://api.github.com/user)") });
    const status = await new HomeGitHub({ run, signIn: idleSignIn(), env: {} }).status();
    expect(status.login).toBeNull();
    expect(status.detail).toContain("Bad credentials");
  });

  it("does not take a login gh did not print cleanly", async () => {
    const { run } = ghScript({ "api user --jq .login": () => ok("not a login\n") });
    expect((await new HomeGitHub({ run, signIn: idleSignIn(), env: {} }).status()).login).toBeNull();
  });

  it("reports when gh is missing from the machine", async () => {
    const run = vi.fn(async () => { throw new Error("spawn gh ENOENT"); });
    const status = await new HomeGitHub({ run, signIn: idleSignIn(), env: {} }).status();
    expect(status).toMatchObject({ login: null, detail: expect.stringContaining("ENOENT") });
  });

  it("connect starts the device flow and returns its code and page", async () => {
    const signIn = idleSignIn();
    signIn.status.mockReturnValue({ phase: "waiting", code: "AB12-CD34", url: "https://github.com/login/device" });
    const { run } = ghScript({ "api user --jq .login": () => failed(GH_NOT_SIGNED_IN_EXIT, "") });
    const status = await new HomeGitHub({ run, signIn, env: {} }).connect();
    expect(signIn.start).toHaveBeenCalledTimes(1);
    expect(status).toEqual({ login: null, signIn: { phase: "waiting", code: "AB12-CD34", url: "https://github.com/login/device" } });
  });

  it("disconnect stops a pending sign-in and logs gh out of github.com", async () => {
    const signIn = idleSignIn();
    let signedIn = true;
    const { run, calls } = ghScript({
      "auth logout --hostname github.com": () => { signedIn = false; return ok(); },
      "api user --jq .login": () => signedIn ? ok("octocat") : failed(GH_NOT_SIGNED_IN_EXIT, ""),
    });
    const status = await new HomeGitHub({ run, signIn, env: {} }).disconnect();
    expect(signIn.cancel).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.args.join(" "))).toEqual(["auth logout --hostname github.com", "api user --jq .login"]);
    expect(status.login).toBeNull();
  });

  it("disconnect is done when gh was already signed out, and fails loudly otherwise", async () => {
    const already = ghScript({ "auth logout --hostname github.com": () => failed(1, "not logged in to any hosts"), "api user --jq .login": () => failed(GH_NOT_SIGNED_IN_EXIT, "") });
    expect((await new HomeGitHub({ run: already.run, signIn: idleSignIn(), env: {} }).disconnect()).login).toBeNull();
    const broken = ghScript({ "auth logout --hostname github.com": () => failed(1, "could not write config: permission denied") });
    await expect(new HomeGitHub({ run: broken.run, signIn: idleSignIn(), env: {} }).disconnect()).rejects.toThrow(/Disconnecting GitHub failed.*permission denied/);
  });

  it("drives gh's real device flow end to end with spawn mocked: code, then setup-git, then the login", async () => {
    const child = fakeChild();
    const spawner = vi.fn(() => { setTimeout(() => child.stderr.emit("data", PROMPT), 10); return child; });
    let signedIn = false;
    const { run, calls } = ghScript({
      "auth setup-git": () => ok(),
      "api user --jq .login": () => signedIn ? ok("octocat\n") : failed(GH_NOT_SIGNED_IN_EXIT, ""),
    });
    const env = { HOME: "/data", GH_TOKEN: "stale" };
    const github = new HomeGitHub({ run, env, signIn: new GitHubDeviceLogin({ spawner: spawner as never, run, promptMs: 2000, env }) });
    const waiting = await github.connect();
    expect(waiting).toMatchObject({ login: null, signIn: { phase: "waiting", code: "AB12-CD34", url: "https://github.com/login/device" } });
    signedIn = true; child.exitCode = 0; child.emit("exit", 0);
    await vi.waitFor(async () => expect((await github.status()).signIn.phase).toBe("done"));
    expect(calls.some((call) => call.args.join(" ") === "auth setup-git")).toBe(true);
    expect(await github.status()).toEqual({ login: "octocat", signIn: expect.objectContaining({ phase: "done" }) });
  });

  it("disconnect during a pending device flow kills gh so it cannot sign in afterwards", async () => {
    const child = fakeChild();
    const spawner = vi.fn(() => { setTimeout(() => child.stderr.emit("data", PROMPT), 10); return child; });
    const { run, calls } = ghScript({ "auth logout --hostname github.com": () => failed(1, "not logged in to any hosts"), "api user --jq .login": () => failed(GH_NOT_SIGNED_IN_EXIT, "") });
    const github = new HomeGitHub({ run, env: {}, signIn: new GitHubDeviceLogin({ spawner: spawner as never, run, promptMs: 2000, env: {} }) });
    await github.connect();
    const status = await github.disconnect();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(status.signIn).toEqual({ phase: "idle" });
    child.exitCode = 0; child.emit("exit", 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.some((call) => call.args.join(" ") === "auth setup-git")).toBe(false);
    expect((await github.status()).signIn).toEqual({ phase: "idle" });
  });
});
