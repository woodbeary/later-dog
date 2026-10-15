import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CLOUD = "https://abc-home.later.dog";
const OTHER_CLOUD = "https://xyz-home.later.dog";
const LOCAL = "http://127.0.0.1:8799";
const LOCAL_DEV = "http://127.0.0.1:8999";
const LOCAL_TOOLS_TOKEN = "a".repeat(43);
const CONNECTION_ENV = ["LATERDOG_URL", "LATERDOG_SERVER_PORT", "LATERDOG_SERVER_TOKEN", "LATERDOG_VARIANT", "LATERDOG_MCP_TIMEOUT_MS", "LATERDOG_LOCAL_CONTROL_TOKEN_FILE"];

interface Call { url: string; method: string; authorization: string | null; localTools: string | null }
type Answer = (url: string, init: RequestInit) => Response | Promise<Response>;

const made: string[] = [];
let folder = "";
let calls: Call[] = [];

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function serve(answer: Answer = () => json(404, { error: "not found" })) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    calls.push({ url, method: init.method ?? "GET", authorization: headers.get("authorization"), localTools: headers.get("x-laterdog-local-tools") });
    const { origin, pathname } = new URL(url);
    if (origin.startsWith("http://127.0.0.1:") && pathname === "/api/health") return json(200, { app: "laterdog" });
    if (origin.startsWith("http://127.0.0.1:") && pathname === "/api/bots") return json(200, { bots: [], from: origin });
    return answer(url, init);
  }));
}

function saveAccess(url: string, token: string) {
  const file = join(folder, "cloud-access.json");
  writeFileSync(file, JSON.stringify({ url, token }), { mode: 0o600 });
  chmodSync(file, 0o600);
}

function forgetAccess() {
  rmSync(join(folder, "cloud-access.json"), { force: true });
}

const load = () => import("./mcp-server.ts");

beforeEach(() => {
  for (const name of CONNECTION_ENV) delete process.env[name];
  folder = mkdtempSync(join(tmpdir(), "laterdog-mcp-cloud-"));
  made.push(folder);
  process.env.LATERDOG_LOCAL_CONTROL_TOKEN_FILE = join(folder, "local-control-token");
  writeFileSync(process.env.LATERDOG_LOCAL_CONTROL_TOKEN_FILE, LOCAL_TOOLS_TOKEN, { mode: 0o600 });
  chmodSync(process.env.LATERDOG_LOCAL_CONTROL_TOKEN_FILE, 0o600);
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const name of CONNECTION_ENV) delete process.env[name];
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("which later.dog the MCP server talks to", () => {
  it("follows the Cloud access file as it appears, moves to another Cloud and goes away", async () => {
    serve((url) => json(200, { bots: [], from: new URL(url).origin }));
    const { request } = await load();

    expect(await request("/api/bots")).toMatchObject({ from: LOCAL });
    expect(calls.at(-1)).toMatchObject({ url: `${LOCAL}/api/bots`, authorization: null, localTools: LOCAL_TOOLS_TOKEN });

    saveAccess(CLOUD, "laterdog_sess_first");
    expect(await request("/api/bots")).toMatchObject({ from: CLOUD });
    expect(calls.at(-1)).toMatchObject({ url: `${CLOUD}/api/bots`, authorization: "Bearer laterdog_sess_first", localTools: null });

    saveAccess(CLOUD, "laterdog_sess_refreshed");
    await request("/api/bots");
    expect(calls.at(-1)).toMatchObject({ url: `${CLOUD}/api/bots`, authorization: "Bearer laterdog_sess_refreshed" });

    saveAccess(OTHER_CLOUD, "laterdog_sess_moved");
    expect(await request("/api/bots")).toMatchObject({ from: OTHER_CLOUD });
    expect(calls.at(-1)).toMatchObject({ url: `${OTHER_CLOUD}/api/bots`, authorization: "Bearer laterdog_sess_moved" });

    forgetAccess();
    calls = [];
    expect(await request("/api/bots")).toMatchObject({ from: LOCAL });
    expect(calls.map((call) => call.url)).toEqual([`${LOCAL}/api/health`, `${LOCAL}/api/bots`]);
    expect(calls.every((call) => call.authorization === null)).toBe(true);
  });

  it("never sends the Cloud session anywhere but its own Cloud", async () => {
    saveAccess(CLOUD, "laterdog_sess_private");
    serve(() => json(200, { bots: [] }));
    const { request } = await load();
    await request("/api/bots", {}, LOCAL);
    expect(calls.at(-1)).toMatchObject({ url: `${LOCAL}/api/bots`, authorization: null });
  });

  it("keeps a dev build on the dev app even when this Mac is signed in to the Cloud", async () => {
    process.env.LATERDOG_VARIANT = "dev";
    saveAccess(CLOUD, "laterdog_sess_release");
    serve();
    const { request, cloudAccess } = await load();
    expect(cloudAccess()).toBeUndefined();
    expect(await request("/api/bots")).toMatchObject({ from: LOCAL_DEV });
    expect(calls.some((call) => call.url.startsWith(CLOUD) || call.authorization)).toBe(false);
  });
});

describe("talking to a Cloud that is asleep or refuses the session", () => {
  beforeEach(() => {
    saveAccess(CLOUD, "laterdog_sess_apps");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  it("waits while the Cloud wakes up, then answers", async () => {
    let asleep = 2;
    serve(() => (asleep-- > 0
      ? json(503, { error: "waking" }, { "x-laterdog-home": "waking", "retry-after": "2" })
      : json(200, { bots: ["awake"] })));
    const { request } = await load();
    const answer = request("/api/bots");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(answer).resolves.toEqual({ bots: ["awake"] });
    expect(calls).toHaveLength(3);
  });

  it("gives up after about a minute and says the Cloud is waking up", async () => {
    serve(() => json(503, { error: "asleep" }, { "x-laterdog-home": "asleep" }));
    const { request, CLOUD_WAKING, CLOUD_WAKE_WAIT_MS } = await load();
    const failure = request("/api/bots", { method: "POST", body: "{}" }).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(CLOUD_WAKE_WAIT_MS + 5_000);
    expect(((await failure) as Error).message).toBe(CLOUD_WAKING);
    expect(calls.length).toBeGreaterThan(10);
    expect(calls.length).toBeLessThanOrEqual(21);
  });

  it("retries a read through a dropped connection but not a write", async () => {
    let dropped = 2;
    serve(() => { if (dropped-- > 0) throw new TypeError("fetch failed"); return json(200, { bots: [] }); });
    const { request, CLOUD_UNREACHABLE } = await load();
    const read = request("/api/bots");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(read).resolves.toEqual({ bots: [] });
    expect(calls).toHaveLength(3);

    serve(() => { throw new TypeError("fetch failed"); });
    await expect(request("/api/bots/bot-1/messages", { method: "POST", body: "{}" })).rejects.toThrow(CLOUD_UNREACHABLE);
    expect(calls).toHaveLength(1);
  });

  it("says the Cloud refused the session, not how to set up local tools", async () => {
    const { request, CLOUD_SESSION_REFUSED } = await load();
    for (const answer of [json(401, { error: "unauthorized" }), json(403, { error: "desktop owner capability required" })]) {
      serve(() => answer);
      const failure = (await request("/api/bots").catch((error: Error) => error)) as Error;
      expect(failure.message).toBe(CLOUD_SESSION_REFUSED);
      expect(failure.message).not.toMatch(/local-control-token|LATERDOG_SERVER_TOKEN|waking/);
      expect(calls).toHaveLength(1);
    }
  });

  it("passes other refusals through without calling them waking", async () => {
    const { request } = await load();
    serve(() => json(403, { error: "forbidden: that dog belongs to someone else" }));
    await expect(request("/api/bots")).rejects.toThrow("later.dog refused this: that dog belongs to someone else");
    serve(() => json(404, { error: "Bot not found" }));
    await expect(request("/api/bots/missing")).rejects.toThrow("later.dog API error (404)");
    serve(() => json(503, { error: "Workspace sign-in is unavailable." }));
    const unavailable = (await request("/api/bots").catch((error: Error) => error)) as Error;
    expect(unavailable.message).toContain("later.dog API error (503)");
    expect(unavailable.message).not.toMatch(/waking/);
    expect(calls).toHaveLength(1);
  });
});
