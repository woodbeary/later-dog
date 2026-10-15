import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Notification } from "../../shared/notification.ts";
import { TOKEN_IN_CONFIG_FILE_FLAG } from "./github-login.ts";
import { GITHUB_CONNECT_LINE, GITHUB_HELPER_LINE, githubFallbackHelper, githubNeededNotification, homeGitEnvironment, homeGitHubPrompt, writeHomeSystemGitConfig } from "./home-git.ts";
import { HomeGitHub } from "./home-github.ts";

const FAKE_GH = `#!/bin/sh
config="\${GH_CONFIG_DIR:-$HOME/.config/gh}"
case "$1 $2" in
  "auth login")
    if [ "$3" = "--help" ]; then echo "      --insecure-storage   Save authentication credentials in plain text instead of credential store"; exit 0; fi
    echo "$*" > "$HOME/.fake-gh-login-args"
    printf '! First copy your one-time code: AB12-CD34\\n' >&2
    printf 'Open this URL to continue in your web browser: https://github.com/login/device\\n' >&2
    while [ ! -e "$HOME/.fake-gh-approved" ]; do sleep 0.05; done
    mkdir -p "$config"
    printf 'github.com:\\n    oauth_token: gho_fake\\n    user: octocat\\n    git_protocol: https\\n' > "$config/hosts.yml"
    chmod 600 "$config/hosts.yml"
    exit 0;;
  "auth setup-git")
    git config --global --replace-all credential.https://github.com.helper ""
    git config --global --add credential.https://github.com.helper "!$0 auth git-credential"
    exit 0;;
  "auth git-credential")
    [ "$3" = get ] || exit 0
    cat >/dev/null
    [ -f "$config/hosts.yml" ] || exit 1
    printf 'protocol=https\\nhost=github.com\\nusername=octocat\\npassword=gho_fake\\n'
    exit 0;;
  "api user")
    [ -f "$config/hosts.yml" ] || { echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4; }
    echo octocat
    exit 0;;
  "auth logout")
    [ -f "$config/hosts.yml" ] || { echo "not logged in to any hosts" >&2; exit 1; }
    rm "$config/hosts.yml"
    exit 0;;
esac
echo "fake gh: unexpected $*" >&2
exit 2
`;

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function cloudHome() {
  const root = mkdtempSync(join(tmpdir(), "laterdog-home-git-"));
  folders.push(root);
  const bin = join(root, "bin");
  const home = join(root, "data");
  mkdirSync(bin); mkdirSync(home);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  const system = join(root, "etc-gitconfig");
  writeHomeSystemGitConfig(system);
  const git = execFileSync("/usr/bin/env", ["which", "git"], { encoding: "utf8" }).trim();
  const env: NodeJS.ProcessEnv = { PATH: [bin, dirname(git), "/usr/bin", "/bin"].join(":"), HOME: home, GIT_CONFIG_SYSTEM: system, LANG: "C", ...homeGitEnvironment() };
  return { home, env, system };
}

function credentialFill(env: NodeJS.ProcessEnv, host = "github.com") {
  const started = Date.now();
  const result = spawnSync("git", ["credential", "fill"], { env, input: `protocol=https\nhost=${host}\npath=woodbeary/later-dog.git\n\n`, encoding: "utf8", timeout: 20_000 });
  return { ...result, ms: Date.now() - started };
}

describe("GitHub for dogs on a Cloud home, with a fake gh and the real git", () => {
  it("fails a push at once with the plain line while GitHub is not connected, then signs git in through gh once it is", async () => {
    const { home, env } = cloudHome();
    const github = new HomeGitHub({ env });

    const before = credentialFill(env);
    expect(before.status).not.toBe(0);
    expect(before.stderr).toContain(GITHUB_HELPER_LINE);
    expect(before.stderr).toMatch(/told us to quit/);
    expect(before.stdout).not.toContain("password=");
    expect(before.ms).toBeLessThan(10_000);
    expect(await github.status()).toEqual({ login: null, signIn: { phase: "idle" } });
    expect(github.lastKnown()).toEqual({ state: "disconnected" });

    const waiting = await github.connect();
    expect(waiting.signIn).toMatchObject({ phase: "waiting", code: "AB12-CD34", url: "https://github.com/login/device" });
    expect(readFileSync(join(home, ".fake-gh-login-args"), "utf8")).toContain(`--web --scopes workflow ${TOKEN_IN_CONFIG_FILE_FLAG}`);

    writeFileSync(join(home, ".fake-gh-approved"), "");
    await expect.poll(async () => (await github.status()).signIn.phase, { timeout: 10_000 }).toBe("done");
    expect(await github.status()).toMatchObject({ login: "octocat", signIn: { phase: "done" } });
    expect(github.lastKnown()).toEqual({ state: "connected", login: "octocat" });
    const hosts = join(home, ".config", "gh", "hosts.yml");
    expect(statSync(hosts).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, ".gitconfig"), "utf8")).toMatch(/\[credential "https:\/\/github\.com"\][\s\S]*helper = ![^\n]*gh auth git-credential/);

    const after = credentialFill(env);
    expect(after.status, after.stderr).toBe(0);
    expect(after.stdout).toContain("username=octocat");
    expect(after.stdout).toContain("password=gho_fake");
    expect(after.stderr).not.toContain(GITHUB_HELPER_LINE);

    expect((await github.disconnect()).login).toBeNull();
    expect(existsSync(hosts)).toBe(false);
    const disconnected = credentialFill(env);
    expect(disconnected.status).not.toBe(0);
    expect(disconnected.stderr).toContain(GITHUB_HELPER_LINE);
  }, 30_000);

  it("never prompts for other hosts, and leaves them to their own helpers", () => {
    const { env } = cloudHome();
    const other = credentialFill(env, "gitlab.example.com");
    expect(other.status).not.toBe(0);
    expect(other.stderr).not.toContain(GITHUB_HELPER_LINE);
    expect(other.stderr).toMatch(/terminal prompts disabled|could not read Username/);
    expect(other.ms).toBeLessThan(10_000);
  });
});

describe("the home's system git config", () => {
  it("holds exactly the fallback helper, readable by the dog user even under the launcher's umask", () => {
    const { env, system } = cloudHome();
    const previous = process.umask(0o077);
    try { writeHomeSystemGitConfig(system); } finally { process.umask(previous); }
    expect(statSync(system).mode & 0o777).toBe(0o644);
    const read = spawnSync("git", ["config", "--file", system, "--get-all", "credential.https://github.com.helper"], { env, encoding: "utf8" });
    expect(read.status, read.stderr).toBe(0);
    expect(read.stdout).toBe(`${githubFallbackHelper()}\n`);
  });
});

describe("what dogs on a Cloud home are told about GitHub", () => {
  it("says plainly that a connected home clones, branches, commits, pushes and opens pull requests without asking", () => {
    const text = homeGitHubPrompt({ state: "connected", login: "woodbeary" }, true);
    expect(text).toContain("GitHub is connected on My Cloud as @woodbeary.");
    expect(text).toContain("Clone their repositories into your working folder, make a branch, commit, push and open pull requests with git and gh right here");
    expect(text).toContain("while their Mac is closed");
    expect(text).toContain("as drafts");
    expect(text).not.toContain(GITHUB_CONNECT_LINE);
    expect(text.startsWith(" ")).toBe(true);
  });

  it("without GitHub, goes through the Mac when it can and otherwise asks once, in one line, never signing in itself", () => {
    const withMac = homeGitHubPrompt({ state: "disconnected" }, true);
    expect(withMac).toContain("GitHub isn't connected on My Cloud yet");
    expect(withMac).toContain("use their Mac instead, without asking");
    expect(withMac).toContain("shared_computer");
    expect(withMac).toContain(`If shared_computer says the Mac is offline, don't retry: tell them in one line, "${GITHUB_CONNECT_LINE}"`);
    expect(withMac).toContain("Never run gh auth login yourself.");
    const withoutMac = homeGitHubPrompt({ state: "disconnected" }, false);
    expect(withoutMac).not.toContain("shared_computer");
    expect(withoutMac).toContain(`don't retry: tell them in one line, "${GITHUB_CONNECT_LINE}"`);
  });

  it("when it isn't known yet, has the dog check first and covers both cases", () => {
    const text = homeGitHubPrompt({ state: "unknown" }, true);
    expect(text).toContain("Run gh auth status before you push.");
    expect(text).toContain("push and open pull requests with git and gh right here");
    expect(text).toContain(GITHUB_CONNECT_LINE);
  });

  it("turns the finished-turn notice into a GitHub notice when the dog asks to connect, and leaves others alone", () => {
    const done: Notification = { kind: "done", botId: "b1", botName: "Rex", threadId: "t1", title: "Rex finished", body: "anything" };
    expect(githubNeededNotification(done, `I committed the fix on a branch. ${GITHUB_CONNECT_LINE}`)).toEqual({ ...done, title: "Rex needs GitHub", body: GITHUB_CONNECT_LINE });
    expect(githubNeededNotification(done, "connect GitHub in Settings so I can push with your Mac closed")).toMatchObject({ title: "Rex needs GitHub" });
    expect(githubNeededNotification(done, "Opened https://github.com/woodbeary/later-dog/pull/70")).toBe(done);
    expect(githubNeededNotification(null, GITHUB_CONNECT_LINE)).toBeNull();
  });

  it("gives the home's server and its dogs a git that never waits on a prompt, through no variable an engine might filter out", () => {
    expect(homeGitEnvironment()).toEqual({ GIT_TERMINAL_PROMPT: "0" });
    expect(GITHUB_HELPER_LINE).not.toMatch(/["`$\\]/);
  });
});
