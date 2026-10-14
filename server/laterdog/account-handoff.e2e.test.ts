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
    write: async (item, text) => { items.set(key(item), Buffer.from(text).toString("hex")); },
  };
  return keychain;
}

const allFiles = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? allFiles(join(root, entry.name)) : [join(root, entry.name)]);

describe("a signed-in desktop hands its Claude and ChatGPT sign-ins to My Cloud and takes them back", () => {
  let root: string, macHome: string, macData: string, homeData: string;
  let homeInstances: InstanceConfigMap, homeOwnLogin: Set<string>, refuseOnce: Set<string>;
  let macRegistry: ProviderRegistry, keychain: FakeKeychain;
  let servers: Array<{ close(): Promise<void> }>;
  let mac: Awaited<ReturnType<typeof serve>>, home: Awaited<ReturnType<typeof serve>>;
  let logs: string[], timers: Array<() => void>, summaries: unknown[];
  let records: string | null;

  const macInstances = (): InstanceConfigMap => ({
    claude: { driver: "claudeAgent" },
    [WORK]: { driver: "claudeAgent", displayName: "Work Claude", config: { configDir: join(macData, "providers", WORK) } },
    codex: { driver: "codex" },
  });
  const macHeldFile = () => join(macData, "providers", "held-accounts.json");
  const homeHeldFile = () => join(homeData, "providers", "held-accounts.json");
  const keychainItem = (service: string) => keychain.items.get(`fixture.user\u0000${service}`);
  const destination = () => ({ origin: home.origin, grant: async () => ({ origin: home.origin, code: PAIRING_CODE }) });

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
    logs = []; timers = []; summaries = []; records = null; servers = [];
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

  const engine = () => createCloudAiAccounts({
    localRequest: (route, init) => fetch(`${mac.origin}${route}`, init),
    keychain,
    read: () => records,
    write: (contents) => { records = contents; },
    setTimer: ((callback: () => void) => { timers.push(callback); return { unref() {} }; }) as unknown as typeof setTimeout,
    clearTimer: (() => {}) as typeof clearTimeout,
    onChange: (summary) => { summaries.push(summary); },
    log: (message) => logs.push(message),
  });

  it("moves every sign-in into its own folder on the home under the same id and name, and this Mac stops using them", async () => {
    const summary = await engine().ensure(destination());
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

  it("reports a failed account by name only, keeps it on this Mac and retries it with the move's backoff", async () => {
    refuseOnce.add("codex");
    const accounts = engine();
    expect(await accounts.ensure(destination())).toEqual({ moved: { claude: 2, chatgpt: 0 }, stayed: [], waiting: ["ChatGPT"] });
    expect(macRegistry.get("codex")).not.toBeNull();
    expect(existsSync(join(homeData, "providers", "codex", "auth.json"))).toBe(false);
    expect(timers).toHaveLength(1);
    expect(await accounts.ensure(destination())).toBeNull();
    timers.shift()!();
    await vi.waitFor(() => expect(summaries).toHaveLength(2));
    expect(summaries[1]).toEqual({ moved: { claude: 0, chatgpt: 1 }, stayed: [], waiting: [] });
    expect(macRegistry.get("codex")).toBeNull();
    expect(await accounts.ensure(destination())).toBeNull();
  });

  it("keeps a sign-in the home made itself, and one this Mac cannot read, on this Mac", async () => {
    homeOwnLogin.add("claude");
    keychain.unreadable = true;
    const summary = await engine().ensure(destination());
    expect(summary).toMatchObject({ stayed: [{ name: "Claude", why: "unreadable" }] });
    keychain.unreadable = false;
    const again = await createCloudAiAccounts({ localRequest: (route, init) => fetch(`${mac.origin}${route}`, init), keychain, read: () => records, write: (contents) => { records = contents; } }).ensure(destination());
    expect(again).toMatchObject({ stayed: [{ name: "Claude", why: "home" }] });
    expect(macRegistry.get("claude")).not.toBeNull();
    expect(existsSync(join(homeData, "providers", "claude"))).toBe(false);
  });

  it("signing out brings each sign-in back as the home last refreshed it, and the home forgets them", async () => {
    const accounts = engine();
    await accounts.ensure(destination());
    writeFileSync(join(homeData, "providers", "claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: fixtureClaudeLogin(2) }));
    writeFileSync(join(homeData, "providers", WORK, ".credentials.json"), JSON.stringify({ claudeAiOauth: fixtureClaudeLogin(12) }));
    writeFileSync(join(homeData, "providers", "codex", "auth.json"), JSON.stringify(fixtureCodexLogin(2)));
    expect(await accounts.bringBack(destination())).toEqual({ returned: expect.arrayContaining(["Claude", "Work Claude", "ChatGPT"]), stayed: [] });
    const restored = JSON.parse(Buffer.from(keychainItem("Claude Code-credentials")!, "hex").toString("utf8"));
    expect(restored).toEqual({ claudeAiOauth: fixtureClaudeLogin(2), mcpOAuth: { fixtureServer: { note: "kept" } } });
    expect(JSON.parse(readFileSync(join(macData, "providers", WORK, ".credentials.json"), "utf8"))).toEqual({ claudeAiOauth: fixtureClaudeLogin(12) });
    expect(JSON.parse(readFileSync(join(macHome, ".codex", "auth.json"), "utf8"))).toEqual(fixtureCodexLogin(2));
    expect(statSync(join(macHome, ".codex", "auth.json")).mode & 0o777).toBe(0o600);
    for (const id of ["claude", WORK, "codex"]) expect(macRegistry.get(id)).not.toBeNull();
    for (const id of ["claude", WORK]) expect(existsSync(join(homeData, "providers", id, ".credentials.json"))).toBe(false);
    expect(existsSync(join(homeData, "providers", "codex", "auth.json"))).toBe(false);
    expect(homeInstances.claude).toEqual({ driver: "claudeAgent", displayName: "Claude", config: { cli: "fixture-claude" } });
    expect(JSON.parse(records!).accounts).toEqual({});
  });

  it("never overwrites a newer sign-in made on this Mac while the account was away", async () => {
    const accounts = engine();
    await accounts.ensure(destination());
    writeFileSync(join(macHome, ".codex", "auth.json"), JSON.stringify(fixtureCodexLogin(3)), { mode: 0o600 });
    writeFileSync(join(homeData, "providers", "codex", "auth.json"), JSON.stringify(fixtureCodexLogin(2)));
    await accounts.bringBack(destination());
    expect(JSON.parse(readFileSync(join(macHome, ".codex", "auth.json"), "utf8"))).toEqual(fixtureCodexLogin(3));
    expect(existsSync(join(homeData, "providers", "codex", "auth.json"))).toBe(false);
  });

  it("keeps an account on the home when it cannot come back yet", async () => {
    const accounts = engine();
    await accounts.ensure(destination());
    const unreachable = { origin: home.origin, grant: async () => ({ origin: home.origin, code: "WRONG-CODE-0000" }) };
    expect(await accounts.bringBack(unreachable)).toEqual({ returned: [], stayed: ["Claude", "Work Claude", "ChatGPT"] });
    expect(macRegistry.get("codex")).toBeNull();
    expect(heldAccountReason(homeHeldFile(), "codex")).toBeNull();
    expect(existsSync(join(homeData, "providers", "codex", "auth.json"))).toBe(true);
  });

  it("never writes a sign-in into logs, answers, summaries, records or the paused-accounts files", async () => {
    const accounts = engine();
    await accounts.ensure(destination());
    await accounts.bringBack(destination());
    const anonymous = await fetch(`${home.origin}/api/laterdog/accounts/claude/return`, { method: "POST" });
    expect(anonymous.status).toBe(403);
    const peek = await fetch(`${mac.origin}/api/laterdog/mac-accounts`);
    const seen = [logs.join("\n"), JSON.stringify(summaries), records ?? "", await peek.text(), await anonymous.text(),
      ...[macHeldFile(), homeHeldFile()].filter(existsSync).map((file) => readFileSync(file, "utf8")),
      ...allFiles(join(homeData, "providers")).filter((path) => path.endsWith("handoff.json")).map((file) => readFileSync(file, "utf8"))];
    for (const text of seen) expect(text).not.toMatch(SECRETS);
  });
});
