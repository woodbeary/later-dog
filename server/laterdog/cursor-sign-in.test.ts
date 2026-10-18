import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cursorSignInLink, cursorSignInPrompt } from "../../shared/device-sign-in.ts";
import type { ProviderInstance } from "../contracts.ts";
import { CursorAgentDriver } from "../drivers/acp/cursor.ts";
import { DeviceAuthController } from "../drivers/device-auth.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { CURSOR_DEVICE_SIGN_IN, readCursorStatus } from "./cursor-sign-in.ts";

const FAKE_CURSOR = fileURLToPath(new URL("../testing/fake-cursor-login-cli.ts", import.meta.url));
const PAGE = "https://cursor.com/loginDeepControl?challenge=fixture-challenge&uuid=fixture-uuid&mode=login";

describe("Cursor sign-in link", () => {
  it("reads Cursor's page from a whole printed line", () => {
    expect(cursorSignInPrompt(`Open the following URL to log in:\n${PAGE}\n`)).toEqual({ authorizationUrl: PAGE });
    expect(cursorSignInPrompt(`Open this link: ${PAGE}\nWaiting...\n`)).toEqual({ authorizationUrl: PAGE });
    expect(cursorSignInPrompt(`Open the following URL to log in:\n${PAGE}`)).toBeNull();
    expect(cursorSignInPrompt(`Docs: https://cursor.com/docs/cli/installation\n${PAGE}\n`)).toEqual({ authorizationUrl: PAGE });
  });

  it.each([
    "http://cursor.com/loginDeepControl",
    "https://cursor.com.evil.test/loginDeepControl",
    "https://evilcursor.com/loginDeepControl",
    "https://user@cursor.com/loginDeepControl",
    "https://cursor.com:8443/loginDeepControl",
    "https://cursor.com/loginDeepControl#token",
    "https://cursor.com/docs/cli/installation",
    "https://docs.cursor.com/loginDeepControl",
    "https://accounts.x.ai/device",
  ])("never turns another page into a sign-in link: %s", (page) => {
    expect(cursorSignInLink(page)).toBeNull();
    expect(cursorSignInPrompt(`${page}\n`)).toBeNull();
  });

  it("reads Cursor's status words", () => {
    expect(readCursorStatus(0, " ✓ Logged in as person@example.test")).toBe("signed-in");
    expect(readCursorStatus(1, " Not logged in")).toBe("signed-out");
    expect(readCursorStatus(0, "Not authenticated")).toBe("signed-out");
    expect(readCursorStatus(0, "Authenticated with API key")).toBe("other");
    expect(readCursorStatus(3, "Something went wrong")).toBe("unknown");
    expect(readCursorStatus(0, "")).toBe("unknown");
  });
});

describe.skipIf(process.platform === "win32")("Cursor sign-in from later.dog", () => {
  let home: string;
  let instances: ProviderInstance[];
  const cursor = async (mode: string, environment: Record<string, string> = {}) => {
    const instance = await CursorAgentDriver.create({
      instanceId: "cursor", displayName: "Cursor", enabled: true,
      config: CursorAgentDriver.decodeConfig({ cli: FAKE_CURSOR }),
      environment: { HOME: home, USERPROFILE: home, LATERDOG_DEVICE_AUTH_FIXTURE: "1", FAKE_CURSOR_MODE: mode, ...environment },
    });
    instances.push(instance);
    return instance;
  };
  const calls = () => readFileSync(join(home, "fake-cursor-calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; noOpenBrowser: string | null });
  const pid = () => Number(readFileSync(join(home, "fake-cursor-login.pid"), "utf8"));
  const alive = (target: number) => { try { process.kill(target, 0); return true; } catch { return false; } };
  const stored = () => join(home, ".config", "cursor", "auth.json");

  beforeEach(() => {
    chmodSync(FAKE_CURSOR, 0o755);
    home = mkdtempSync(join(tmpdir(), "laterdog-cursor-sign-in-"));
    instances = [];
  });
  afterEach(async () => {
    await Promise.all(instances.map((instance) => instance.dispose()));
    await removeTempDir(home);
  });

  it("asks Cursor for the link without opening a browser on the server, then confirms the account", async () => {
    const instance = await cursor("success");
    expect((await instance.snapshot()).authenticated).toBe(false);
    const start = await instance.startAuthentication!();
    expect(start).toMatchObject({ phase: "waiting", authorizationUrl: PAGE, flowId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(start.userCode).toBeUndefined();
    await expect.poll(async () => (await instance.getAuthentication!(start.flowId!)).phase, { timeout: 5_000 }).toBe("succeeded");
    expect(existsSync(stored())).toBe(true);
    expect((await instance.snapshot()).authenticated).toBe(true);
    expect(calls().filter((call) => call.args[0] === "login")).toEqual([{ args: ["login"], noOpenBrowser: "1" }]);
  });

  it("is already done when Cursor is signed in", async () => {
    mkdirSync(join(home, ".config", "cursor"), { recursive: true });
    writeFileSync(stored(), "{}");
    const instance = await cursor("waiting");
    expect(await instance.startAuthentication!()).toMatchObject({ phase: "succeeded" });
    expect(calls().some((call) => call.args[0] === "login")).toBe(false);
  });

  it("cancels: the login process stops", async () => {
    const instance = await cursor("waiting");
    const start = await instance.startAuthentication!();
    expect(alive(pid())).toBe(true);
    await instance.cancelAuthentication!();
    expect(alive(pid())).toBe(false);
    expect(await instance.getAuthentication!(start.flowId!)).toMatchObject({ phase: "cancelled", message: "Cursor sign-in cancelled.", authorizationUrl: null });
  });

  it("ends a declined sign-in with one plain message and none of the CLI's words", async () => {
    const instance = await cursor("denied");
    const start = await instance.startAuthentication!();
    await expect.poll(async () => (await instance.getAuthentication!(start.flowId!)).phase, { timeout: 5_000 }).toBe("failed");
    const status = await instance.getAuthentication!(start.flowId!);
    expect(status.message).toBe("Cursor sign-in was declined in the browser. Start sign-in again to try once more.");
    expect(JSON.stringify(status)).not.toContain("secret-token");
  });

  it("does not show a page on another host, and gives up waiting for one", async () => {
    const controller = new DeviceAuthController(CURSOR_DEVICE_SIGN_IN, {
      cli: FAKE_CURSOR, startupTimeoutMs: 1_000, terminateTimeoutMs: 50,
      environment: () => ({ ...process.env, HOME: home, LATERDOG_DEVICE_AUTH_FIXTURE: "1", FAKE_CURSOR_MODE: "evil" }),
    });
    try {
      await expect(controller.start()).rejects.toThrow("Cursor did not provide a sign-in code in time");
      await controller.cancel();
      expect(alive(pid())).toBe(false);
    } finally { await controller.dispose(); }
  });

  it("signs out with Cursor's own logout and checks it took", async () => {
    const instance = await cursor("success");
    expect(instance.signOut).toBeTypeOf("function");
    const start = await instance.startAuthentication!();
    await expect.poll(async () => (await instance.getAuthentication!(start.flowId!)).phase, { timeout: 5_000 }).toBe("succeeded");
    await instance.signOut!();
    expect(existsSync(stored())).toBe(false);
    expect((await instance.snapshot()).authenticated).toBe(false);
    const liar = await cursor("logout-lies");
    mkdirSync(join(home, ".config", "cursor"), { recursive: true });
    writeFileSync(stored(), "{}");
    await expect(liar.signOut!()).rejects.toThrow("Cursor still reports a sign-in on this server.");
  });

  it("says plainly when Cursor is missing", async () => {
    const missing = await CursorAgentDriver.create({
      instanceId: "cursor-missing", displayName: "Cursor", enabled: true,
      config: CursorAgentDriver.decodeConfig({ cli: join(home, "no-such-cursor-agent") }),
      environment: { HOME: home, LATERDOG_DEVICE_AUTH_FIXTURE: "1" },
    });
    instances.push(missing);
    await expect(missing.startAuthentication!()).rejects.toThrow("Cursor is not installed on this server.");
  });
});
