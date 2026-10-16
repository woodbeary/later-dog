import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { GitHubDeviceLogin, parseGitHubDevicePrompt } from "./github-login.ts";

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; killed: boolean; unref: () => void };
function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null as number | null, killed: false, unref: () => {} });
}
const PROMPT = "! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n";

describe("GitHub device sign-in on the supervisor host", () => {
  it("reads gh's code and page from its non-interactive output, and nothing else", () => {
    expect(parseGitHubDevicePrompt(PROMPT)).toEqual({ code: "AB12-CD34", url: "https://github.com/login/device" });
    expect(parseGitHubDevicePrompt("! First copy your one-time code: AB12-CD")).toBeNull();
    expect(parseGitHubDevicePrompt("Open https://evil.example/login/device code AB12-CD34")).toBeNull();
  });

  it("starts gh's device flow without GH_TOKEN, reports the code, does not start twice, and sets up git when done", async () => {
    const children: FakeChild[] = [];
    const spawner = vi.fn((binary: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      expect(binary).toBe("gh");
      expect(args).toEqual(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--scopes", "workflow"]);
      expect(options.env.GH_TOKEN).toBeUndefined(); expect(options.env.GITHUB_TOKEN).toBeUndefined(); expect(options.env.GH_PROMPT_DISABLED).toBe("1");
      const child = fakeChild(); children.push(child);
      setTimeout(() => child.stderr.emit("data", PROMPT), 10);
      return child;
    });
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }));
    const login = new GitHubDeviceLogin({ spawner: spawner as never, run, promptMs: 2000, env: { PATH: "/usr/bin", GH_TOKEN: "stale", GITHUB_TOKEN: "stale" } });
    expect(login.status()).toEqual({ phase: "idle" });
    const first = await login.start();
    expect(first).toMatchObject({ phase: "waiting", code: "AB12-CD34", url: "https://github.com/login/device" });
    const again = await login.start();
    expect(again.code).toBe("AB12-CD34"); expect(spawner).toHaveBeenCalledTimes(1);
    children[0].exitCode = 0; children[0].emit("exit", 0);
    await vi.waitFor(() => expect(login.status().phase).toBe("done"));
    expect(run).toHaveBeenCalledWith("gh", ["auth", "setup-git"], expect.objectContaining({ timeoutMs: 30_000 }));
    expect(login.status().code).toBeUndefined();
  });

  it("reports a declined or expired sign-in as failed, with gh's last words", async () => {
    const child = fakeChild();
    const login = new GitHubDeviceLogin({ spawner: (() => { setTimeout(() => child.stderr.emit("data", PROMPT), 10); return child; }) as never, run: vi.fn(), promptMs: 2000, env: {} });
    await login.start();
    child.stderr.emit("data", "error: the device code expired\n"); child.exitCode = 1; child.emit("exit", 1);
    await vi.waitFor(() => expect(login.status().phase).toBe("failed"));
    expect(login.status().detail).toContain("expired");
  });

  it("fails clearly when gh prints no code in time", async () => {
    const login = new GitHubDeviceLogin({ spawner: (() => fakeChild()) as never, run: vi.fn(), promptMs: 150, env: {} });
    const status = await login.start();
    expect(status.phase).toBe("failed"); expect(status.detail).toContain("no sign-in code");
  });
});
