import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceConfigMap } from "../contracts.ts";
import { ProviderRegistry } from "../harness/registry.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { RouteContext } from "../routes/table.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { HELD_ACCOUNT_REASON, heldAccountReason, readHeldAccounts } from "./held-accounts.ts";
import { createMacAccountRoutes, macAccountSources, type MacAccountDeps } from "./mac-accounts.ts";

const UUID = "0f6c5a52-8d1e-4c3b-9a7e-2b1d0c9e8f7a";
const desktop = { kind: "loopback", scopes: ["admin", "client"] } as unknown as RequestAuth;

async function call(deps: MacAccountDeps, method: string, path: string, auth: RequestAuth = desktop) {
  const sent: { status?: number; body?: unknown } = {};
  const ctx = {
    req: { headers: {} }, res: { setHeader: () => {} }, url: new URL(`http://127.0.0.1${path}`), path, method, auth,
    json: (_res: unknown, status: number, value: unknown) => { sent.status = status; sent.body = value; },
    readBody: async () => ({}),
  } as unknown as RouteContext;
  await createMacAccountRoutes(deps)(ctx);
  return sent;
}

describe("this Mac's Claude and ChatGPT sign-ins, as the desktop app sees them", () => {
  let home: string;
  let dataDir: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "laterdog-mac-accounts-"));
    dataDir = join(home, ".laterdog");
    mkdirSync(dataDir);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USER", "fixture.user");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    vi.stubEnv("CODEX_HOME", "");
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

  const instances = (): InstanceConfigMap => ({
    claude: { driver: "claudeAgent" },
    [`claude-${UUID}`]: { driver: "claudeAgent", displayName: "Work Claude", config: { configDir: join(dataDir, "providers", `claude-${UUID}`) } },
    claudeApi: { driver: "claudeAgent", access: "api", config: { requireApiKey: true } },
    "company.claude": { driver: "claudeAgent", config: { managed: { models: ["x"] } } },
    codex: { driver: "codex" },
    chatgpt: { driver: "codex", displayName: "ChatGPT plan", config: { authMode: "chatgpt-plan" } },
  });

  it("finds each sign-in where the CLI keeps it: the Keychain item, the plaintext file and Codex's auth.json", () => {
    const planFolder = join(dataDir, "providers", "chatgpt-plan", createHash("sha256").update("chatgpt").digest("hex"));
    mkdirSync(planFolder, { recursive: true });
    writeFileSync(join(planFolder, "credentials.json"), "{}");
    const sources = macAccountSources(instances(), { dataDir, held: new Set([`claude-${UUID}`]), platform: "darwin" });
    const suffix = createHash("sha256").update(join(dataDir, "providers", `claude-${UUID}`)).digest("hex").slice(0, 8);
    expect(sources).toEqual([
      { instanceId: "claude", kind: "claude", displayName: "Claude", held: false, file: join(home, ".claude", ".credentials.json"),
        keychain: { service: "Claude Code-credentials", account: "fixture.user" } },
      { instanceId: `claude-${UUID}`, kind: "claude", displayName: "Work Claude", held: true, file: join(dataDir, "providers", `claude-${UUID}`, ".credentials.json"),
        keychain: { service: `Claude Code-credentials-${suffix}`, account: "fixture.user" } },
      { instanceId: "codex", kind: "codex", displayName: "ChatGPT", held: false, file: join(home, ".codex", "auth.json") },
      { instanceId: "chatgpt", kind: "chatgpt-plan", displayName: "ChatGPT plan", held: false, stays: "chatgpt-plan" },
    ]);
  });

  it("leaves out a Codex login kept in the Keychain and names no Keychain item off macOS", () => {
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), "cli_auth_credentials_store = \"keyring\"\n");
    const sources = macAccountSources(instances(), { dataDir, held: new Set(), platform: "linux" });
    expect(sources.map((source) => source.instanceId)).toEqual(["claude", `claude-${UUID}`]);
    expect(sources.every((source) => !("keychain" in source))).toBe(true);
  });

  function fakeMac(busy = new Set<string>()) {
    const reloads: string[] = [];
    const deps: MacAccountDeps = {
      cloudHome: false, dataDir, file: join(dataDir, "providers", "held-accounts.json"), instances, platform: "darwin",
      busy: (id) => busy.has(id),
      exclusive: async (work) => work(),
      reload: async (id) => { reloads.push(id); },
    };
    return { deps, reloads };
  }

  it("answers only this Mac's own desktop app, never on a Cloud home", async () => {
    const { deps } = fakeMac();
    expect((await call({ ...deps, cloudHome: true }, "GET", "/api/laterdog/mac-accounts")).status).toBe(403);
    for (const auth of [
      { kind: "session", via: "bearer", scopes: ["admin", "client"] },
      { kind: "loopback", scopes: ["client"], trust: "service" },
      { kind: "loopback", scopes: ["admin", "client"], localTools: true },
    ]) expect((await call(deps, "GET", "/api/laterdog/mac-accounts", auth as unknown as RequestAuth)).status).toBe(403);
    expect((await call(deps, "GET", "/api/laterdog/mac-accounts")).status).toBe(200);
  });

  it("pauses an account on this Mac before it moves, never while a dog is using it, and lets it go again", async () => {
    const busy = new Set(["codex"]);
    const { deps, reloads } = fakeMac(busy);
    expect(await call(deps, "PUT", "/api/laterdog/mac-accounts/codex/hold")).toMatchObject({ status: 409, body: { code: "busy" } });
    expect(readHeldAccounts(deps.file).size).toBe(0);
    busy.clear();
    expect(await call(deps, "PUT", "/api/laterdog/mac-accounts/codex/hold")).toMatchObject({ status: 200, body: { held: true } });
    expect(heldAccountReason(deps.file, "codex")).toBe(HELD_ACCOUNT_REASON.cloud);
    expect(reloads).toEqual(["codex"]);
    expect((await call(deps, "PUT", "/api/laterdog/mac-accounts/chatgpt/hold")).status).toBe(404);
    expect((await call(deps, "PUT", "/api/laterdog/mac-accounts/claudeApi/hold")).status).toBe(404);
    expect(await call(deps, "DELETE", "/api/laterdog/mac-accounts/codex/hold")).toMatchObject({ status: 200, body: { held: false } });
    expect(heldAccountReason(deps.file, "codex")).toBeNull();
  });

  it("never starts an account that is on My Cloud: no CLI, no turn, no token refresh on this Mac", async () => {
    const fake = makeFakeDriver({ kind: "claudeAgent" });
    const { deps } = fakeMac();
    await call(deps, "PUT", `/api/laterdog/mac-accounts/claude-${UUID}/hold`);
    const registry = new ProviderRegistry([fake.driver], { held: (id) => heldAccountReason(deps.file, id) });
    await registry.load({ claude: { driver: "claudeAgent" }, [`claude-${UUID}`]: { driver: "claudeAgent", displayName: "Work Claude" } });
    expect(registry.get(`claude-${UUID}`)).toBeNull();
    expect([...fake.created.keys()]).toEqual(["claude"]);
    expect(registry.entries().find((entry) => entry.instanceId === `claude-${UUID}`)?.shadow).toMatchObject({
      displayName: "Work Claude", reason: HELD_ACCOUNT_REASON.cloud,
    });
    await call(deps, "DELETE", `/api/laterdog/mac-accounts/claude-${UUID}/hold`);
    await registry.load({ [`claude-${UUID}`]: { driver: "claudeAgent", displayName: "Work Claude" } });
    expect(registry.get(`claude-${UUID}`)).not.toBeNull();
  });
});
