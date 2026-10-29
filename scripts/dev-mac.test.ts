import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appLending, DEV_ENV_ID, DEV_SHARING_NAME, devProtectedPaths, devRecord, shouldLend, startDevMac } from "./dev-mac.mjs";

const ORIGIN = "https://he6e3bd4d404f3dfb6be1a40b-home.later.dog";
const ACCOUNT = "7eaec07f-4e74-4682-81c2-d3bf10549606";
const APP_ENV = "91807ca8-8889-43cb-a944-dbaaeef48ac4";
const MAC = "5b0f2c4e-7d1a-4e3b-9c8d-2a1b3c4d5e6f";

function appRecord(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "1f2e3d4c-5b6a-4987-8a7b-6c5d4e3f2a1b", environmentId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", id: MAC, secret: "f".repeat(64),
    enabled: true, home: true, folders: [{ id: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f", path: "/Users/jacob", name: "Home", write: true }],
    terminal: true, computer: true, cloud: { accountId: ACCOUNT, origin: ORIGIN }, ...overrides,
  };
}

function setup({ app = { version: 1, records: { [APP_ENV]: appRecord() } } as unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dev-mac-"));
  const sessionFile = join(dir, "my-home.session.json");
  writeFileSync(sessionFile, JSON.stringify({ url: `${ORIGIN}/`, token: "laterdog_sess_test" }));
  const appFile = join(dir, "computer-sharing.json");
  if (app) writeFileSync(appFile, JSON.stringify(app));
  const made: { options: Record<string, any>; calls: string[] }[] = [];
  const create = (options: Record<string, any>) => {
    const sharing = { options, calls: [] as string[] };
    made.push(sharing);
    return {
      state: () => ({ connected: sharing.calls.includes("connected") }),
      start: () => { sharing.calls.push("start"); },
      forget: (env: { id: string }) => { sharing.calls.push(`forget ${env.id}`); },
      close: () => { sharing.calls.push("close"); },
    };
  };
  return { dir, sessionFile, appFile, made, create };
}

describe("later.dog Dev connecting this Mac to the person's Cloud", () => {
  it("finds the later.dog app's own connection to this home, and only that one", () => {
    expect(appLending({ version: 1, records: { [APP_ENV]: appRecord() } }, ORIGIN)?.envId).toBe(APP_ENV);
    expect(appLending({ version: 1, records: { [APP_ENV]: appRecord() } }, "https://other-home.later.dog")).toBeNull();
    expect(appLending({ version: 1, homeOff: true, records: { [APP_ENV]: appRecord() } }, ORIGIN)).toBeNull();
    expect(appLending({ version: 1, records: { [APP_ENV]: appRecord({ enabled: false }) } }, ORIGIN)).toBeNull();
    expect(appLending(null, ORIGIN)).toBeNull();
  });

  it("keeps the Mac's identity but takes its own sign-in, so the home sees the same Mac", () => {
    const copy = devRecord(appRecord());
    expect(copy).toMatchObject({ id: MAC, secret: "f".repeat(64), home: true, cloud: { accountId: ACCOUNT, origin: ORIGIN } });
    expect(copy.sessionId).toBeNull();
    expect(copy.environmentId).toBeNull();
  });

  it("connects unless the later.dog app is open and already connecting this Mac", () => {
    expect(shouldLend({ appRunning: false, appLends: true })).toBe(true);
    expect(shouldLend({ appRunning: true, appLends: false })).toBe(true);
    expect(shouldLend({ appRunning: true, appLends: true })).toBe(false);
  });

  it("keeps dogs out of the folders that hold later.dog's own session tokens", () => {
    expect(devProtectedPaths("/Users/jacob")).toEqual(["/Users/jacob/.laterdog-dev", "/Users/jacob/.laterdog-dev-tools", "/Users/jacob/.laterdog-test-home"]);
  });

  it("connects as the same Mac while the app is closed, stands by while it is open, and comes back when it quits", async () => {
    const { dir, sessionFile, appFile, made, create } = setup();
    let open = false;
    const lines: string[] = [];
    const mac = startDevMac({ sessionFile, dataDir: dir, appFile, appRunning: async () => open, create: create as never, log: (line: string) => lines.push(line), checkMs: 60_000, home: "/Users/jacob" });
    await mac.check();
    expect(mac.lending()).toBe(true);
    expect(made).toHaveLength(1);
    const options = made[0]!.options;
    expect(options.environments()).toEqual([{ id: APP_ENV, name: "My Cloud", origin: ORIGIN }]);
    expect(options.cloud()).toEqual({ status: "connected", accountId: ACCOUNT, origin: ORIGIN });
    const saved = JSON.parse(readFileSync(join(dir, DEV_SHARING_NAME), "utf8"));
    expect(saved.records[APP_ENV]).toMatchObject({ id: MAC, environmentId: null, sessionId: null });
    expect(made[0]!.calls).toEqual(["start"]);

    open = true;
    await mac.check();
    expect(mac.lending()).toBe(false);
    expect(made[0]!.calls).toEqual(["start", `forget ${APP_ENV}`, "close"]);

    open = false;
    await mac.check();
    expect(mac.lending()).toBe(true);
    expect(made).toHaveLength(2);
    expect(lines).toEqual([
      "connecting this Mac to he6e3bd4d404f3dfb6be1a40b-home.later.dog from later.dog Dev",
      "later.dog is open and connects this Mac, so later.dog Dev stands by",
      "connecting this Mac to he6e3bd4d404f3dfb6be1a40b-home.later.dog from later.dog Dev",
    ]);

    await mac.stop();
    expect(made[1]!.calls).toEqual(["start", `forget ${APP_ENV}`, "close"]);
  });

  it("says the Mac is connected only once the home has taken it", async () => {
    const { dir, sessionFile, appFile, made, create } = setup();
    const lines: string[] = [];
    const mac = startDevMac({ sessionFile, dataDir: dir, appFile, appRunning: async () => false, create: create as never, log: (line: string) => lines.push(line), checkMs: 60_000 });
    await mac.check();
    made[0]!.options.onChange();
    made[0]!.calls.push("connected");
    made[0]!.options.onChange();
    made[0]!.options.onChange();
    expect(lines).toEqual([
      "connecting this Mac to he6e3bd4d404f3dfb6be1a40b-home.later.dog from later.dog Dev",
      "this Mac is connected to he6e3bd4d404f3dfb6be1a40b-home.later.dog",
    ]);
    await mac.stop();
  });

  it("signs every call to the home with the Dev session", async () => {
    const { dir, sessionFile, appFile, made, create } = setup();
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = async (url: string, init: { headers?: Record<string, string> } = {}) => { seen.push({ url, headers: init.headers ?? {} }); return new Response("{}"); };
    const mac = startDevMac({ sessionFile, dataDir: dir, appFile, appRunning: async () => false, create: create as never, fetchImpl: fetchImpl as never, log: () => {}, checkMs: 60_000 });
    await mac.check();
    await made[0]!.options.fetch(`${ORIGIN}/api/shared-computers/connect`, { method: "POST", headers: { "x-laterdog-lending": "1" } });
    expect(seen[0]!.headers).toEqual({ "x-laterdog-lending": "1", authorization: "Bearer laterdog_sess_test" });
    await mac.stop();
  });

  it("connects as a new Mac when the later.dog app has never connected this one", async () => {
    const { dir, sessionFile, appFile, made, create } = setup({ app: null });
    const mac = startDevMac({ sessionFile, dataDir: dir, appFile, appRunning: async () => false, create: create as never, log: () => {}, checkMs: 60_000 });
    await mac.check();
    expect(made[0]!.options.environments()).toEqual([{ id: DEV_ENV_ID, name: "My Cloud", origin: ORIGIN }]);
    await mac.stop();
  });
});
