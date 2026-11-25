import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { AntigravitySignIn } from "./antigravity-sign-in.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp-cli.ts");
const dirs: string[] = [];
const instances: ProviderInstance[] = [];
const controllers: AntigravitySignIn[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.dispose();
  for (const instance of instances.splice(0)) await instance.dispose();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function fakeEnvironment(dir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: dir,
    DISPLAY: ":0",
    WAYLAND_DISPLAY: "wayland-0",
    FAKE_ACP_DUMP: join(dir, "dump.json"),
    FAKE_ACP_RPC_DUMP: join(dir, "rpc.json"),
    FAKE_ACP_AGENT_NAME: "Antigravity ACP Server",
    FAKE_ACP_AUTH_FILE: join(dir, "signed-in"),
    FAKE_ACP_LOGIN_DUMP: join(dir, "login.json"),
    FAKE_ACP_LOGIN_INPUT: join(dir, "pasted.txt"),
    ...extra,
  };
}

function scratch(): string {
  ensureDirs();
  chmodSync(FAKE_CLI, 0o755);
  const dir = mkdtempSync(join(tmpdir(), "laterdog-agy-login-"));
  dirs.push(dir);
  return dir;
}

async function antigravity(extra: Record<string, string> = {}) {
  const dir = scratch();
  const instance = await AntigravityDriver.create({
    instanceId: "antigravity",
    displayName: "Antigravity",
    enabled: true,
    environment: fakeEnvironment(dir, extra),
    config: { cli: FAKE_CLI, fullAuto: false },
  });
  instances.push(instance);
  return { dir, instance };
}

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("Antigravity sign-in with a pasted Google code", () => {
  it("shows agy's Google link, hands agy the pasted text unchanged and reports signed in", async () => {
    const landing = "https://antigravity.google/oauth-callback?code=4/0Ab Cd&scope=openid ";
    const { dir, instance } = await antigravity({ FAKE_ACP_LOGIN_CODE: landing });
    expect(instance.getAuthentication && instance.completeAuthentication && instance.cancelAuthentication).toBeTruthy();
    expect(instance.authenticationMethod).toBeUndefined();
    expect(await instance.snapshot()).toMatchObject({ authenticated: false });
    const started = await instance.startAuthentication!();
    expect(started).toMatchObject({ phase: "waiting", flowId: expect.any(String), expiresAt: expect.any(String) });
    const link = new URL(started.authorizationUrl!);
    expect([link.protocol, link.host, link.pathname]).toEqual(["https:", "accounts.google.com", "/o/oauth2/auth"]);
    const login = json(join(dir, "login.json"));
    expect(login.argv).toEqual(["acp", "--gemini-dir", join(dir, ".gemini"), "--login"]);
    expect(login.env.DISPLAY).toBeUndefined();
    expect(login.env.WAYLAND_DISPLAY).toBeUndefined();
    expect(login.env.BROWSER).toBeUndefined();
    expect(login.env).toMatchObject({ AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "true", AGY_CLI_DISABLE_AUTO_UPDATE: "true" });
    expect(json(join(dir, "dump.json.initialize.json")).clientCapabilities.auth).toEqual({ terminal: true });
    await instance.completeAuthentication!(started.flowId!, landing);
    expect(readFileSync(join(dir, "pasted.txt"), "utf8")).toBe(`${landing}\n`);
    expect(await instance.getAuthentication!(started.flowId!)).toMatchObject({ phase: "succeeded" });
    expect(await instance.snapshot()).toMatchObject({ authenticated: true });
    expect(json(join(dir, "rpc.json"))).not.toContain("authenticate");
  });

  it("fails with agy's own words when Google refuses the code", async () => {
    const { instance } = await antigravity();
    const started = await instance.startAuthentication!();
    await expect(instance.completeAuthentication!(started.flowId!, "not-a-code")).rejects.toThrow(/couldn't log in: token exchange failed/);
    expect(await instance.getAuthentication!(started.flowId!)).toMatchObject({
      phase: "failed",
      message: expect.stringMatching(/couldn't log in: token exchange failed: oauth2: "invalid_grant"/),
    });
    expect(await instance.snapshot()).toMatchObject({ authenticated: false });
  });

  it("runs the sign-in arguments agy offers and falls back to --login", async () => {
    const offered = await antigravity({ FAKE_ACP_TERMINAL_LOGIN_ARGS: JSON.stringify(["--login", "--no-launch"]) });
    await offered.instance.startAuthentication!();
    expect(json(join(offered.dir, "login.json")).argv.slice(-2)).toEqual(["--login", "--no-launch"]);
    const unlisted = await antigravity({ FAKE_ACP_TERMINAL_LOGIN: "0" });
    await unlisted.instance.startAuthentication!();
    expect(json(join(unlisted.dir, "login.json")).argv.slice(-1)).toEqual(["--login"]);
  });

  it("stops agy's sign-in when it is cancelled", async () => {
    const { dir, instance } = await antigravity();
    const started = await instance.startAuthentication!();
    const { pid } = json(join(dir, "login.json"));
    expect(alive(pid)).toBe(true);
    await instance.cancelAuthentication!();
    await until(() => !alive(pid));
    expect(await instance.getAuthentication!(started.flowId!)).toMatchObject({ phase: "cancelled" });
  });

  it("stops agy's sign-in when it expires", async () => {
    const dir = scratch();
    const controller = new AntigravitySignIn({
      launch: async () => ({ command: FAKE_CLI, args: ["acp"], env: { ...process.env, ...fakeEnvironment(dir) } }),
      expiresInMs: 1_500,
    });
    controllers.push(controller);
    const started = await controller.start();
    const { pid } = json(join(dir, "login.json"));
    await until(async () => (await controller.get(started.flowId!)).phase === "expired");
    await until(() => !alive(pid));
  });
});
