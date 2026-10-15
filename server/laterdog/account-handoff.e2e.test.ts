import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudAiAccounts, type MacKeychain } from "../../electron/cloud-ai-accounts.mjs";
import type { InstanceConfig, InstanceConfigMap } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import { ProviderRegistry } from "../harness/registry.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteContext, type RouteHandler } from "../routes/table.ts";
import { fixtureClaudeLogin, fixtureCodexLogin } from "../testing/fake-ai-logins.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { heldAccountReason } from "./held-accounts.ts";
import { createHomeAccountRoutes } from "./home-accounts.ts";
import { createMacAccountRoutes } from "./mac-accounts.ts";

const UUID = "0f6c5a52-8d1e-4c3b-9a7e-2b1d0c9e8f7a";
const WORK = `claude-${UUID}`;
const TOKEN = "laterdog_sess_fixture-owner-device";
const PAIRING_CODE = "FIXT-URE0-CODE";
const SECRETS = /fixture-(?:claude|codex)-(?:access|refresh|id)-\d/;

const desktop = { kind: "loopback", scopes: ["admin", "client"] } as unknown as RequestAuth;
const ownerDevice = { kind: "session", via: "bearer", scopes: ["admin", "client"], session: { id: "fixture" } } as unknown as RequestAuth;
const stranger = { kind: "session", via: "cookie", scopes: ["client"], session: { id: "other" } } as unknown as RequestAuth;

async function serve(route: RouteHandler, authFor: (req: IncomingMessage) => RequestAuth, extra?: (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean>) {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (extra && await extra(req, res, url.pathname)) return;
      const ctx = { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: authFor(req), json, readBody } as RouteContext;
      if (await route(ctx) === PASS) json(res, 404, { error: "not found" });
    })().catch(() => { if (!res.headersSent) json(res, 500, { error: "failed" }); });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, close: () => new Promise<void>((done) => server.close(() => done())) };
}

type FakeKeychain = MacKeychain & { items: Map<string, string>; unreadable: boolean };

function fakeKeychain(): FakeKeychain {
  const items = new Map<string, string>();
  const key = (item: { service: string; account: string }) => `${item.account}\u0000${item.service}`;
  const keychain: FakeKeychain = {
    items, unreadable: false,
    has: async (item) => items.has(key(item)),
    read: async (item) => (keychain.unreadable ? null : items.get(key(item)) ?? null),
  };
  return keychain;
}

const allFiles = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? allFiles(join(root, entry.name)) : [join(root, entry.name)]);

describe("a signed-in desktop hands its Claude and ChatGPT sign-ins to My Cloud and keeps them there", () => {
  let root: string, macHome: string, macData: string, homeData: string;
  let homeInstances: InstanceConfigMap, homeOwnLogin: Set<string>, refuseOnce: Set<string>, dropAnswer: Set<string>;
  let macRegistry: ProviderRegistry, keychain: FakeKeychain;
  let servers: Array<{ close(): Promise<void> }>;
  let mac: Awaited<ReturnType<typeof serve>>, home: Awaited<ReturnType<typeof serve>>;
  let logs: string[], timers: Array<() => void>, summaries: unknown[];
  let records: string | null;
  let macExtra: InstanceConfigMap;

  const macInstances = (): InstanceConfigMap => ({
    claude: { driver: "claudeAgent" },
    [WORK]: { driver: "claudeAgent", displayName: "Work Claude", config: { configDir: join(macData, "providers", WORK) } },
    codex: { driver: "codex" },
    ...macExtra,
  });
  const macHeldFile = () => join(macData, "providers", "held-accounts.json");
  const homeHeldFile = () => join(homeData, "providers", "held-accounts.json");
  const hand = (accounts: { handAccountsToCloud(request: { homeOrigin: string; session: () => Promise<{ origin: string; code: string }> }): Promise<unknown> }, code = PAIRING_CODE) =>
    accounts.handAccountsToCloud({ homeOrigin: home.origin, session: async () => ({ origin: home.origin, code }) });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "laterdog-account-handoff-"));
    macHome = join(root, "mac");
    macData = join(macHome, ".laterdog");
    homeData = join(root, "home", ".laterdog");
    mkdirSync(join(macData, "providers", WORK), { recursive: true });
    mkdirSync(join(macHome, ".codex"), { recursive: true });
    mkdirSync(homeData, { recursive: true });
    vi.stubEnv("HOME", macHome);
    vi.stubEnv("USER", "fixture.user");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    vi.stubEnv("CODEX_HOME", "");
    logs = []; timers = []; summaries = []; records = null; servers = []; macExtra = {};
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });

    keychain = fakeKeychain();
    keychain.items.set("fixture.user\u0000Claude Code-credentials", Buffer.from(JSON.stringify({ claudeAiOauth: fixtureClaudeLogin(1), mcpOAuth: { fixtureServer: { note: "kept" } } })).toString("hex"));
    writeFileSync(join(macData, "providers", WORK, ".credentials.json"), JSON.stringify({ claudeAiOauth: fixtureClaudeLogin(11) }), { mode: 0o600 });
    writeFileSync(join(macHome, ".codex", "auth.json"), JSON.stringify(fixtureCodexLogin(1)), { mode: 0o600 });

    const fake = makeFakeDriver({ kind: "claudeAgent" });
    const fakeCodex = makeFakeDriver({ kind: "codex" });
    macRegistry = new ProviderRegistry([fake.driver, fakeCodex.driver], { held: (id) => heldAccountReason(macHeldFile(), id) });
    await macRegistry.load(macInstances());
    let macBusy = false;
    const macRoutes = createMacAccountRoutes({
      cloudHome: false, dataDir: macData, file: macHeldFile(), instances: macInstances, platform: "darwin",
      busy: () => false,
      exclusive: async (work) => { if (macBusy) return null; macBusy = true; try { return await work(); } finally { macBusy = false; } },
      reload: async (id) => { await macRegistry.load({ [id]: macInstances()[id] }); },
    });
    mac = await serve(macRoutes, () => desktop);

    homeInstances = { claude: { driver: "claudeAgent", config: { cli: "fixture-claude" } }, codex: { driver: "codex" } };
    homeOwnLogin = new Set();
    refuseOnce = new Set();
    dropAnswer = new Set();
    let homeBusy = false;
    const signedIn = (id: string, entry: InstanceConfig | undefined) => {
      if (!entry || heldAccountReason(homeHeldFile(), id)) return false;
      const dir = entry.driver === "claudeAgent" ? (entry.config as { configDir?: string } | undefined)?.configDir : entry.environment?.CODEX_HOME;
      return dir ? existsSync(join(dir, entry.driver === "claudeAgent" ? ".credentials.json" : "auth.json")) : homeOwnLogin.has(id);
    };
    const homeRoutes = createHomeAccountRoutes({
      cloudHome: true, dataDir: homeData, file: homeHeldFile(),
      instances: () => structuredClone(homeInstances),
      save: async (_id, next) => { homeInstances = structuredClone(next); },
      reload: async () => {},
      busy: () => false,
      exclusive: async (work) => { if (homeBusy) return null; homeBusy = true; try { return await work(); } finally { homeBusy = false; } },
      signedIn: async (id) => signedIn(id, homeInstances[id]),
    });
    home = await serve(homeRoutes, (req) => (req.headers.authorization === `Bearer ${TOKEN}` ? ownerDevice : stranger), async (req, res, path) => {
      if (path === "/api/auth/pair" && req.method === "POST") {
        const body = await readBody(req) as { code?: unknown };
        json(res, body.code === PAIRING_CODE ? 200 : 401, body.code === PAIRING_CODE ? { token: TOKEN } : { error: "bad code" });
        return true;
      }
      if (path === "/api/auth/logout") { json(res, 200, { ok: true }); return true; }
      const id = /^\/api\/laterdog\/accounts\/([\w.-]+)$/.exec(path)?.[1];
      if (id && req.method === "PUT" && refuseOnce.delete(id)) { req.resume(); json(res, 503, { error: "busy" }); return true; }
      return false;
    });
    servers.push(mac, home);
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const engine = (store = { read: () => records, write: (contents: string) => { records = contents; } }) => createCloudAiAccounts({
    fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      const id = /\/api\/laterdog\/accounts\/([\w.-]+)$/.exec(String(url))?.[1];
      if (id && dropAnswer.delete(id)) throw new Error("connection lost");
      return response;
    },
    localRequest: (route, init) => fetch(`${mac.origin}${route}`, init),
    keychain,
    read: store.read,
    write: store.write,
    setTimer: ((callback: () => void) => { timers.push(callback); return { unref() {} }; }) as unknown as typeof setTimeout,
    clearTimer: (() => {}) as typeof clearTimeout,
    onChange: (summary) => { summaries.push(summary); },
    log: (message) => logs.push(message),
  });

  it("moves every sign-in into its own folder on the home under the same id and name, and this Mac stops using them", async () => {
    const summary = await hand(engine());
    expect(summary).toEqual({ moved: { claude: 2, chatgpt: 1 }, stayed: [], waiting: [] });
    const credentials = (id: string) => JSON.parse(readFileSync(join(homeData, "providers", id, ".credentials.json"), "utf8"));
    expect(credentials("claude")).toEqual({ claudeAiOauth: fixtureClaudeLogin(1) });
    expect(credentials(WORK)).toEqual({ claudeAiOauth: fixtureClaudeLogin(11) });
    expect(JSON.parse(readFileSync(join(homeData, "providers", "codex", "auth.json"), "utf8"))).toEqual(fixtureCodexLogin(1));
    for (const file of allFiles(join(homeData, "providers")).filter((path) => /credentials|auth\.json|handoff/.test(path))) expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(homeInstances[WORK]).toMatchObject({ driver: "claudeAgent", displayName: "Work Claude" });
    expect(homeInstances.claude).toMatchObject({ config: { cli: "fixture-claude", configDir: join(homeData, "providers", "claude") } });
    expect(homeInstances.codex).toMatchObject({ environment: { CODEX_HOME: join(homeData, "providers", "codex") } });
    for (const id of ["claude", WORK, "codex"]) expect(macRegistry.get(id)).toBeNull();
    expect(Object.keys(JSON.parse(records!).accounts).sort()).toEqual(["claude", "codex", WORK].sort());
  });

  it("moves a numbered ChatGPT account like ChatGPT 2 into its own folder on the home, and this Mac stops using it", async () => {
    const own = join(macData, "providers", "codex-2");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "auth.json"), JSON.stringify(fixtureCodexLogin(2)), { mode: 0o600 });
    macExtra = { "codex-2": { driver: "codex", displayName: "ChatGPT 2", environment: { CODEX_HOME: own } } };
    await macRegistry.load(macInstances());
    expect(macRegistry.get("codex-2")).not.toBeNull();
    expect(await hand(engine())).toEqual({ moved: { claude: 2, chatgpt: 2 }, stayed: [], waiting: [] });
    expect(JSON.parse(readFileSync(join(homeData, "providers", "codex-2", "auth.json"), "utf8"))).toEqual(fixtureCodexLogin(2));
    expect(JSON.parse(readFileSync(join(homeData, "providers", "codex", "auth.json"), "utf8"))).toEqual(fixtureCodexLogin(1));
    expect(homeInstances["codex-2"]).toEqual({ driver: "codex", displayName: "ChatGPT 2", environment: { CODEX_HOME: join(homeData, "providers", "codex-2") } });
    for (const id of ["codex", "codex-2"]) expect(macRegistry.get(id)).toBeNull();
    expect(JSON.parse(records!).accounts["codex-2"]).toMatchObject({ kind: "codex", name: "ChatGPT 2", source: "file" });
  });

  it("reports a failed account by name only, keeps it paused on this Mac and retries it with the move's backoff", async () => {
    refuseOnce.add("codex");
    const accounts = engine();
    expect(await hand(accounts)).toEqual({ moved: { claude: 2, chatgpt: 0 }, stayed: [], waiting: ["ChatGPT"] });
    expect(macRegistry.get("codex")).toBeNull();
    expect(existsSync(join(homeData, "providers", "codex", "auth.json"))).toBe(false);
    expect(timers).toHaveLength(1);
    expect(await hand(accounts)).toBeNull();
    timers.shift()!();
    await vi.waitFor(() => expect(summaries).toHaveLength(2));
    expect(summaries[1]).toEqual({ moved: { claude: 0, chatgpt: 1 }, stayed: [], waiting: [] });
    expect(macRegistry.get("codex")).toBeNull();
    expect(await hand(accounts)).toBeNull();
  });

  it("keeps a sign-in the home made itself, and one this Mac cannot read, on this Mac", async () => {
    homeOwnLogin.add("claude");
    keychain.unreadable = true;
    const summary = await hand(engine());
    expect(summary).toMatchObject({ stayed: [{ name: "Claude", why: "unreadable" }] });
    keychain.unreadable = false;
    const again = await createCloudAiAccounts({ localRequest: (route, init) => fetch(`${mac.origin}${route}`, init), keychain, read: () => records, write: (contents) => { records = contents; } }).handAccountsToCloud({ homeOrigin: home.origin, session: async () => ({ origin: home.origin, code: PAIRING_CODE }) });
    expect(again).toMatchObject({ stayed: [{ name: "Claude", why: "home" }] });
    expect(macRegistry.get("claude")).not.toBeNull();
    expect(existsSync(join(homeData, "providers", "claude"))).toBe(false);
  });

  it("moves a login exactly once, however often the move is announced", async () => {
    const accounts = engine();
    await hand(accounts);
    const before = readFileSync(join(homeData, "providers", "codex", "auth.json"), "utf8");
    writeFileSync(join(macHome, ".codex", "auth.json"), JSON.stringify(fixtureCodexLogin(5)), { mode: 0o600 });
    expect(await hand(accounts)).toBeNull();
    expect(await hand(engine())).toEqual({ moved: { claude: 0, chatgpt: 0 }, stayed: [], waiting: [] });
    expect(readFileSync(join(homeData, "providers", "codex", "auth.json"), "utf8")).toBe(before);
    expect(macRegistry.get("codex")).toBeNull();
  });

  it("keeps the account paused on this Mac when the home's acceptance answer is lost, and retries until the home confirms", async () => {
    dropAnswer.add("codex");
    const accounts = engine();
    expect(await hand(accounts)).toEqual({ moved: { claude: 2, chatgpt: 0 }, stayed: [], waiting: ["ChatGPT"] });
    expect(existsSync(join(homeData, "providers", "codex", "auth.json"))).toBe(true);
    expect(macRegistry.get("codex")).toBeNull();
    expect(heldAccountReason(macHeldFile(), "codex")).not.toBeNull();
    expect(JSON.parse(records!).accounts.codex).toBeUndefined();
    expect(timers).toHaveLength(1);
    timers.shift()!();
    await vi.waitFor(() => expect(summaries).toHaveLength(2));
    expect(summaries[1]).toEqual({ moved: { claude: 0, chatgpt: 1 }, stayed: [], waiting: [] });
    expect(macRegistry.get("codex")).toBeNull();
    expect(JSON.parse(records!).accounts.codex).toBeDefined();
  });

  it("keeps retrying with the last delay when the home stays unreachable, never un-pausing the account", async () => {
    refuseOnce.add("codex");
    const accounts = createCloudAiAccounts({
      fetchImpl: async () => { throw new Error("offline"); },
      localRequest: (route, init) => fetch(`${mac.origin}${route}`, init),
      keychain, read: () => records, write: (contents) => { records = contents; },
      retryDelaysMs: [10, 20],
      setTimer: ((callback: () => void, delay: number) => { timers.push(callback); delays.push(delay); return { unref() {} }; }) as unknown as typeof setTimeout,
      clearTimer: (() => {}) as typeof clearTimeout,
    });
    const delays: number[] = [];
    await hand(accounts);
    for (let round = 0; round < 3; round++) {
      timers.shift()!();
      await vi.waitFor(() => expect(timers).toHaveLength(1));
    }
    expect(delays).toEqual([10, 20, 20, 20]);
    for (const id of ["claude", WORK, "codex"]) expect(macRegistry.get(id)).toBeNull();
  });

  it("leaves the account on this Mac only after the home refuses it, and keeps a login another computer handed over", async () => {
    await hand(engine());
    const before = readFileSync(join(homeData, "providers", WORK, ".credentials.json"), "utf8");
    for (const id of ["claude", WORK, "codex"]) await fetch(`${mac.origin}/api/laterdog/mac-accounts/${id}/hold`, { method: "DELETE" });
    writeFileSync(join(macData, "providers", WORK, ".credentials.json"), JSON.stringify({ claudeAiOauth: fixtureClaudeLogin(21) }), { mode: 0o600 });
    let secondRecords: string | null = null;
    const second = engine({ read: () => secondRecords, write: (contents) => { secondRecords = contents; } });
    const summary = await hand(second);
    expect(summary).toMatchObject({ stayed: [{ name: "Work Claude", why: "refused" }], waiting: [] });
    expect(readFileSync(join(homeData, "providers", WORK, ".credentials.json"), "utf8")).toBe(before);
    expect(macRegistry.get(WORK)).not.toBeNull();
    expect(JSON.parse(secondRecords!).accounts[WORK]).toBeUndefined();
  });

  it("does not hand accounts moved to one home over to a different home", async () => {
    await hand(engine());
    const saved = JSON.parse(records!);
    for (const entry of Object.values(saved.accounts) as Array<{ origin: string }>) entry.origin = "http://127.0.0.1:9";
    saved.origin = "http://127.0.0.1:9";
    records = JSON.stringify(saved);
    const summary = await hand(engine());
    expect(summary).toMatchObject({ moved: { claude: 0, chatgpt: 0 }, waiting: [], stayed: expect.arrayContaining([{ name: "Claude", why: "elsewhere" }]) });
    for (const id of ["claude", WORK, "codex"]) expect(macRegistry.get(id)).toBeNull();
  });

  it("never writes a sign-in into logs, answers, summaries, records or the paused-accounts files", async () => {
    const accounts = engine();
    await hand(accounts);
    const anonymous = await fetch(`${home.origin}/api/laterdog/accounts/claude`, { method: "PUT" });
    expect(anonymous.status).toBe(403);
    const peek = await fetch(`${mac.origin}/api/laterdog/mac-accounts`);
    const seen = [logs.join("\n"), JSON.stringify(summaries), records ?? "", await peek.text(), await anonymous.text(),
      ...[macHeldFile(), homeHeldFile()].filter(existsSync).map((file) => readFileSync(file, "utf8")),
      ...allFiles(join(homeData, "providers")).filter((path) => path.endsWith("handoff.json")).map((file) => readFileSync(file, "utf8"))];
    for (const text of seen) expect(text).not.toMatch(SECRETS);
  });
});
