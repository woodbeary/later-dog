import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstanceConfig, InstanceConfigMap } from "../contracts.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { RouteContext } from "../routes/table.ts";
import { fixtureClaudeLogin, fixtureCodexLogin } from "../testing/fake-ai-logins.ts";
import { heldAccountReason } from "./held-accounts.ts";
import { createHomeAccountRoutes, type HomeAccountDeps } from "./home-accounts.ts";

const DEVICE = "a".repeat(32);
const OTHER_DEVICE = "b".repeat(32);
const UUID = "0f6c5a52-8d1e-4c3b-9a7e-2b1d0c9e8f7a";
const session = (via: "bearer" | "cookie", scopes: string[]) =>
  ({ kind: "session", via, scopes, session: { id: "fixture-session", label: "Accounts from this Mac" } }) as unknown as RequestAuth;
const ownerDevice = session("bearer", ["admin", "client"]);

interface Home {
  deps: HomeAccountDeps;
  state: { instances: InstanceConfigMap; ownLogin: Set<string>; failSignIn: boolean; busy: Set<string>; reloads: string[] };
}

function fakeHome(dataDir: string, instances: InstanceConfigMap = { claude: { driver: "claudeAgent", config: { cli: "fixture-claude" } }, codex: { driver: "codex" } }): Home {
  const state = { instances: structuredClone(instances), ownLogin: new Set<string>(), failSignIn: false, busy: new Set<string>(), reloads: [] as string[] };
  const file = join(dataDir, "providers", "held-accounts.json");
  const loggedIn = (id: string, entry: InstanceConfig | undefined) => {
    if (!entry || heldAccountReason(file, id)) return false;
    const config = (entry.config ?? {}) as { configDir?: string };
    if (entry.driver === "claudeAgent") return config.configDir ? existsSync(join(config.configDir, ".credentials.json")) : state.ownLogin.has(id);
    return entry.environment?.CODEX_HOME ? existsSync(join(entry.environment.CODEX_HOME, "auth.json")) : state.ownLogin.has(id);
  };
  let busy = false;
  const deps: HomeAccountDeps = {
    cloudHome: true,
    dataDir,
    file,
    instances: () => structuredClone(state.instances),
    save: async (id, next) => { state.instances = structuredClone(next); state.reloads.push(id); },
    reload: async (id) => { state.reloads.push(id); },
    busy: (id) => state.busy.has(id),
    exclusive: async (work) => { if (busy) return null; busy = true; try { return await work(); } finally { busy = false; } },
    signedIn: async (id) => !state.failSignIn && loggedIn(id, state.instances[id]),
  };
  return { deps, state };
}

async function call(deps: HomeAccountDeps, method: string, path: string, body?: unknown, options: { auth?: RequestAuth; contentType?: string } = {}) {
  const sent: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const ctx = {
    req: { headers: { "content-type": options.contentType ?? "application/json" } },
    res: { setHeader: (name: string, value: string) => { sent.headers[name] = value; } },
    url: new URL(`https://home.test${path}`), path, method, auth: options.auth ?? ownerDevice,
    json: (_res: unknown, status: number, value: unknown) => { sent.status = status; sent.body = value; },
    readBody: async (_req: unknown, limit: number) => {
      if (JSON.stringify(body ?? {}).length > limit) throw Object.assign(new Error("body too large"), { status: 413 });
      return body;
    },
  } as unknown as RouteContext;
  await createHomeAccountRoutes(deps)(ctx);
  return sent;
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe("My Cloud receiving this Mac's Claude and ChatGPT sign-ins", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "laterdog-home-accounts-")); });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it("accepts a sign-in only from the paired owner device on a Cloud home", async () => {
    const { deps } = fakeHome(dataDir);
    const body = { kind: "claude", displayName: "Work Claude", deviceId: DEVICE, login: fixtureClaudeLogin() };
    expect((await call({ ...deps, cloudHome: false }, "PUT", `/api/laterdog/accounts/claude-${UUID}`, body)).status).toBe(403);
    for (const auth of [session("cookie", ["admin", "client"]), session("bearer", ["client"]), { kind: "loopback", scopes: ["admin", "client"] } as unknown as RequestAuth]) {
      expect((await call(deps, "PUT", `/api/laterdog/accounts/claude-${UUID}`, body, { auth })).status).toBe(403);
    }
    expect(existsSync(join(dataDir, "providers", `claude-${UUID}`))).toBe(false);
  });

  it("takes a numbered Claude account like Claude 2 under the same name the Mac's dogs use", async () => {
    const { deps, state } = fakeHome(dataDir);
    const answer = await call(deps, "PUT", "/api/laterdog/accounts/claude-2", { kind: "claude", displayName: "Claude 2", deviceId: DEVICE, login: fixtureClaudeLogin() });
    expect(answer).toMatchObject({ status: 200, body: { instanceId: "claude-2", signedIn: true } });
    expect(state.instances["claude-2"]).toMatchObject({ driver: "claudeAgent", displayName: "Claude 2", config: { configDir: join(dataDir, "providers", "claude-2") } });
  });

  it("takes a numbered ChatGPT account like ChatGPT 2 into its own folder under the same name, with the home's Codex CLI", async () => {
    const { deps, state } = fakeHome(dataDir, { codex: { driver: "codex", config: { cli: "fixture-codex" } } });
    const answer = await call(deps, "PUT", "/api/laterdog/accounts/codex-2", { kind: "codex", displayName: "ChatGPT 2", deviceId: DEVICE, login: fixtureCodexLogin(2) });
    expect(answer).toMatchObject({ status: 200, body: { instanceId: "codex-2", signedIn: true } });
    const folder = join(dataDir, "providers", "codex-2");
    expect(state.instances["codex-2"]).toEqual({ driver: "codex", displayName: "ChatGPT 2", config: { cli: "fixture-codex" }, environment: { CODEX_HOME: folder } });
    expect(state.instances.codex).toEqual({ driver: "codex", config: { cli: "fixture-codex" } });
    expect(mode(folder)).toBe(0o700);
    expect(mode(join(folder, "auth.json"))).toBe(0o600);
    expect(JSON.parse(readFileSync(join(folder, "auth.json"), "utf8"))).toEqual(fixtureCodexLogin(2));
    expect(readFileSync(join(folder, "config.toml"), "utf8")).toBe("cli_auth_credentials_store = \"file\"\n");
    expect(existsSync(join(dataDir, "providers", "codex"))).toBe(false);
  });

  it("refuses a numbered ChatGPT account whose folder another ChatGPT account on the home already uses", async () => {
    const taken = join(dataDir, "providers", "codex-2");
    const { deps, state } = fakeHome(dataDir, { codex: { driver: "codex" }, "codex-3": { driver: "codex", environment: { CODEX_HOME: taken } } });
    const answer = await call(deps, "PUT", "/api/laterdog/accounts/codex-2", { kind: "codex", displayName: "ChatGPT 2", deviceId: DEVICE, login: fixtureCodexLogin() });
    expect(answer).toMatchObject({ status: 409, body: { code: "different_account" } });
    expect(existsSync(join(taken, "auth.json"))).toBe(false);
    expect(state.instances["codex-2"]).toBeUndefined();
  });

  it("refuses odd names, the wrong kind, other content types and oversized or damaged bodies without echoing them", async () => {
    const { deps } = fakeHome(dataDir);
    const good = { kind: "claude", displayName: "Work Claude", deviceId: DEVICE, login: fixtureClaudeLogin() };
    for (const id of ["chatgpt-plan", "claude-not-a-uuid", "claude-12345", "..", "company.claude"]) expect((await call(deps, "PUT", `/api/laterdog/accounts/${id}`, good)).status).toBe(400);
    expect((await call(deps, "PUT", "/api/laterdog/accounts/codex", good)).status).toBe(400);
    expect((await call(deps, "PUT", "/api/laterdog/accounts/codex-2", good)).status).toBe(400);
    const chatgpt = { kind: "codex", displayName: "ChatGPT 2", deviceId: DEVICE, login: fixtureCodexLogin() };
    expect((await call(deps, "PUT", "/api/laterdog/accounts/claude-2", chatgpt)).status).toBe(400);
    for (const id of ["codex-12345", "codex-two", "codex-"]) expect((await call(deps, "PUT", `/api/laterdog/accounts/${id}`, chatgpt)).status).toBe(400);
    expect(existsSync(join(dataDir, "providers", "codex-2"))).toBe(false);
    expect((await call(deps, "PUT", "/api/laterdog/accounts/claude", good, { contentType: "text/plain" })).status).toBe(415);
    expect((await call(deps, "PUT", "/api/laterdog/accounts/claude", { ...good, displayName: "x".repeat(70_000) })).status).toBe(413);
    const damaged = await call(deps, "PUT", "/api/laterdog/accounts/claude", { ...good, login: { ...fixtureClaudeLogin(), refreshToken: "" } });
    expect(damaged.status).toBe(400);
    expect(JSON.stringify(damaged.body)).not.toContain("fixture-claude-access-1");
    expect(existsSync(join(dataDir, "providers", "claude"))).toBe(false);
  });

  it("writes a Claude sign-in privately into that account's own folder and lists it under the Mac's id and name", async () => {
    const { deps, state } = fakeHome(dataDir);
    const id = `claude-${UUID}`;
    const answer = await call(deps, "PUT", `/api/laterdog/accounts/${id}`, { kind: "claude", displayName: "Work Claude", deviceId: DEVICE, login: fixtureClaudeLogin() });
    expect(answer).toMatchObject({ status: 200, body: { instanceId: id, signedIn: true } });
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(answer.body)).not.toContain("fixture-claude");
    const folder = join(dataDir, "providers", id);
    expect(mode(folder)).toBe(0o700);
    expect(mode(join(folder, ".credentials.json"))).toBe(0o600);
    expect(JSON.parse(readFileSync(join(folder, ".credentials.json"), "utf8"))).toEqual({ claudeAiOauth: fixtureClaudeLogin() });
    expect(readFileSync(join(folder, "handoff.json"), "utf8")).not.toContain("fixture-claude");
    expect(state.instances[id]).toEqual({ driver: "claudeAgent", displayName: "Work Claude", config: { cli: "fixture-claude", configDir: folder } });
  });

  it("keeps a sign-in the home made itself and never overwrites it", async () => {
    const { deps, state } = fakeHome(dataDir);
    state.ownLogin.add("claude");
    const answer = await call(deps, "PUT", "/api/laterdog/accounts/claude", { kind: "claude", displayName: "Claude", deviceId: DEVICE, login: fixtureClaudeLogin() });
    expect(answer).toMatchObject({ status: 409, body: { code: "home_signed_in" } });
    expect(existsSync(join(dataDir, "providers", "claude"))).toBe(false);
    expect(state.instances.claude).toEqual({ driver: "claudeAgent", config: { cli: "fixture-claude" } });
  });

  it("answers a repeated hand-over without replacing a sign-in the home has refreshed since", async () => {
    const { deps } = fakeHome(dataDir);
    const body = { kind: "claude", displayName: "Claude", deviceId: DEVICE, login: fixtureClaudeLogin(1) };
    expect((await call(deps, "PUT", "/api/laterdog/accounts/claude", body)).status).toBe(200);
    const file = join(dataDir, "providers", "claude", ".credentials.json");
    writeFileSync(file, JSON.stringify({ claudeAiOauth: fixtureClaudeLogin(2) }), { mode: 0o600 });
    expect((await call(deps, "PUT", "/api/laterdog/accounts/claude", body)).status).toBe(200);
    expect(JSON.parse(readFileSync(file, "utf8")).claudeAiOauth.refreshToken).toBe("fixture-claude-refresh-2");
  });

  it("undoes everything when the home cannot sign in with what arrived", async () => {
    const { deps, state } = fakeHome(dataDir);
    state.failSignIn = true;
    const id = `claude-${UUID}`;
    const answer = await call(deps, "PUT", `/api/laterdog/accounts/${id}`, { kind: "claude", displayName: "Work Claude", deviceId: DEVICE, login: fixtureClaudeLogin() });
    expect(answer).toMatchObject({ status: 422, body: { code: "not_signed_in" } });
    expect(existsSync(join(dataDir, "providers", id, ".credentials.json"))).toBe(false);
    expect(state.instances[id]).toBeUndefined();
  });

  it("puts a ChatGPT sign-in where the Codex CLI reads it, as a file", async () => {
    const { deps, state } = fakeHome(dataDir);
    expect((await call(deps, "PUT", "/api/laterdog/accounts/codex", { kind: "codex", displayName: "ChatGPT", deviceId: DEVICE, login: fixtureCodexLogin() })).status).toBe(200);
    const folder = join(dataDir, "providers", "codex");
    expect(mode(join(folder, "auth.json"))).toBe(0o600);
    expect(JSON.parse(readFileSync(join(folder, "auth.json"), "utf8"))).toEqual(fixtureCodexLogin());
    expect(readFileSync(join(folder, "config.toml"), "utf8")).toBe("cli_auth_credentials_store = \"file\"\n");
    expect(state.instances.codex.environment).toEqual({ CODEX_HOME: folder });
  });

  it("has no way to give a sign-in back: no return, keep or forget", async () => {
    const { deps } = fakeHome(dataDir);
    await call(deps, "PUT", "/api/laterdog/accounts/codex", { kind: "codex", displayName: "ChatGPT", deviceId: DEVICE, login: fixtureCodexLogin(1) });
    expect((await call(deps, "POST", "/api/laterdog/accounts/codex/return")).status).toBeUndefined();
    expect((await call(deps, "POST", "/api/laterdog/accounts/codex/keep")).status).toBeUndefined();
    expect((await call(deps, "POST", "/api/laterdog/accounts/codex")).status).toBe(405);
    expect((await call(deps, "DELETE", "/api/laterdog/accounts/codex")).status).toBe(405);
    expect(existsSync(join(dataDir, "providers", "codex", "auth.json"))).toBe(true);
  });

  it("refuses a login another computer already handed over, and says so", async () => {
    const { deps } = fakeHome(dataDir);
    const id = `claude-${UUID}`;
    const first = { kind: "claude", displayName: "Work Claude", deviceId: DEVICE, login: fixtureClaudeLogin(1) };
    expect((await call(deps, "PUT", `/api/laterdog/accounts/${id}`, first)).status).toBe(200);
    const second = await call(deps, "PUT", `/api/laterdog/accounts/${id}`, { ...first, deviceId: OTHER_DEVICE, login: fixtureClaudeLogin(2) });
    expect(second).toMatchObject({ status: 409, body: { code: "other_device" } });
    expect(JSON.parse(readFileSync(join(dataDir, "providers", id, ".credentials.json"), "utf8")).claudeAiOauth.refreshToken).toBe("fixture-claude-refresh-1");
    expect((await call(deps, "PUT", `/api/laterdog/accounts/${id}`, { ...first, deviceId: OTHER_DEVICE })).status).toBe(200);
  });

  it("lets another computer replace a login only when it is the same provider account", async () => {
    const { deps } = fakeHome(dataDir);
    const withAccount = (n: number, accountId: string) => { const login = fixtureCodexLogin(n); return { ...login, tokens: { ...login.tokens, account_id: accountId } }; };
    const first = { kind: "codex", displayName: "ChatGPT", deviceId: DEVICE, login: withAccount(1, "acct-one") };
    expect((await call(deps, "PUT", "/api/laterdog/accounts/codex", first)).status).toBe(200);
    const stranger = await call(deps, "PUT", "/api/laterdog/accounts/codex", { ...first, deviceId: OTHER_DEVICE, login: withAccount(2, "acct-two") });
    expect(stranger).toMatchObject({ status: 409, body: { code: "other_device" } });
    const same = await call(deps, "PUT", "/api/laterdog/accounts/codex", { ...first, deviceId: OTHER_DEVICE, login: withAccount(3, "acct-one") });
    expect(same.status).toBe(200);
    expect(JSON.parse(readFileSync(join(dataDir, "providers", "codex", "auth.json"), "utf8")).tokens.refresh_token).toBe("fixture-codex-refresh-3");
  });

  it("lets the same computer hand over a newer login for the account it already moved", async () => {
    const { deps } = fakeHome(dataDir);
    const body = (n: number) => ({ kind: "claude", displayName: "Claude", deviceId: DEVICE, login: fixtureClaudeLogin(n) });
    expect((await call(deps, "PUT", "/api/laterdog/accounts/claude", body(1))).status).toBe(200);
    expect((await call(deps, "PUT", "/api/laterdog/accounts/claude", body(2))).status).toBe(200);
    expect(JSON.parse(readFileSync(join(dataDir, "providers", "claude", ".credentials.json"), "utf8")).claudeAiOauth.refreshToken).toBe("fixture-claude-refresh-2");
  });

  it("refuses a hand-over with no computer identity", async () => {
    const { deps } = fakeHome(dataDir);
    expect((await call(deps, "PUT", "/api/laterdog/accounts/claude", { kind: "claude", displayName: "Claude", login: fixtureClaudeLogin() })).status).toBe(400);
  });
});
