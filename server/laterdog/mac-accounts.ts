import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configuredAccountDirectory } from "../claude-accounts.ts";
import type { InstanceConfig, InstanceConfigMap } from "../contracts.ts";
import { codexHome } from "../drivers/codex-identity.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import { MOVABLE_ACCOUNT_ID, accountKindOf, type AiAccountKind } from "./ai-account-login.ts";
import { claudeCredentialsFile, claudeKeychainAccount, claudeKeychainService } from "./claude-keychain.ts";
import { readHeldAccounts, setHeldAccount } from "./held-accounts.ts";

export type MacAccountSource =
  | { instanceId: string; kind: AiAccountKind; displayName: string; held: boolean; file: string; keychain?: { service: string; account: string } }
  | { instanceId: string; kind: "chatgpt-plan"; displayName: string; held: false; stays: "chatgpt-plan" };

export interface MacAccountDeps {
  cloudHome: boolean;
  dataDir: string;
  file: string;
  instances(): InstanceConfigMap;
  busy(instanceId: string): boolean;
  exclusive<T>(work: () => Promise<T>): Promise<T | null>;
  reload(instanceId: string): Promise<void>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const ROUTE = /^\/api\/laterdog\/mac-accounts(?:\/([\w.-]+)\/hold)?$/;
const CODEX_STORE = /^\s*cli_auth_credentials_store\s*=\s*["']?(\w+)["']?/m;

const raw = (entry: InstanceConfig): Record<string, unknown> =>
  entry.config && typeof entry.config === "object" && !Array.isArray(entry.config) ? entry.config as Record<string, unknown> : {};

function subscriptionClaude(entry: InstanceConfig): boolean {
  const config = raw(entry);
  return entry.driver === "claudeAgent" && entry.access !== "api" && !config.managed && config.requireApiKey !== true;
}

function ownCodex(entry: InstanceConfig): boolean {
  const config = raw(entry);
  return entry.driver === "codex" && config.authMode !== "chatgpt-plan" && !config.managed;
}

function codexUsesFile(home: string): boolean {
  try {
    const store = CODEX_STORE.exec(readFileSync(join(home, "config.toml"), "utf8"))?.[1];
    return store === undefined || store === "file" || store === "auto";
  } catch {
    return true;
  }
}

function numberedCodexSharesHome(instances: InstanceConfigMap, instanceId: string, home: string, env: NodeJS.ProcessEnv): boolean {
  if (instanceId === "codex") return false;
  return Object.entries(instances).some(([otherId, other]) => otherId !== instanceId && ownCodex(other) && codexHome({ ...env, ...other.environment }) === home);
}

export function macAccountSources(instances: InstanceConfigMap, options: { dataDir: string; held: ReadonlySet<string>; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): MacAccountSource[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const sources: MacAccountSource[] = [];
  for (const [instanceId, entry] of Object.entries(instances)) {
    const merged = { ...env, ...entry.environment };
    if (MOVABLE_ACCOUNT_ID.test(instanceId) && accountKindOf(instanceId) === "claude" && subscriptionClaude(entry)) {
      let directory: string;
      try { directory = configuredAccountDirectory(entry); } catch { continue; }
      const storage = { CLAUDE_CONFIG_DIR: directory || undefined, CLAUDE_SECURESTORAGE_CONFIG_DIR: merged.CLAUDE_SECURESTORAGE_CONFIG_DIR };
      const home = merged.HOME || merged.USERPROFILE || homedir();
      sources.push({
        instanceId, kind: "claude", displayName: entry.displayName ?? "Claude", held: options.held.has(instanceId),
        file: claudeCredentialsFile(storage, home),
        ...(platform === "darwin" ? { keychain: { service: claudeKeychainService(storage), account: claudeKeychainAccount(merged) } } : {}),
      });
    } else if (MOVABLE_ACCOUNT_ID.test(instanceId) && accountKindOf(instanceId) === "codex" && ownCodex(entry)) {
      const home = codexHome(merged);
      if (!home || !codexUsesFile(home) || numberedCodexSharesHome(instances, instanceId, home, env)) continue;
      sources.push({ instanceId, kind: "codex", displayName: entry.displayName ?? "ChatGPT", held: options.held.has(instanceId), file: join(home, "auth.json") });
    } else if (entry.driver === "codex" && raw(entry).authMode === "chatgpt-plan" && !raw(entry).managed) {
      const directory = join(options.dataDir, "providers", "chatgpt-plan", createHash("sha256").update(instanceId).digest("hex"));
      if (existsSync(join(directory, "credentials.json"))) {
        sources.push({ instanceId, kind: "chatgpt-plan", displayName: entry.displayName ?? "ChatGPT plan", held: false, stays: "chatgpt-plan" });
      }
    }
  }
  return sources;
}

const desktopOwner = (auth: RequestAuth) => auth.kind === "loopback" && auth.scopes.includes("admin") && !auth.trust && !auth.localTools;

export function createMacAccountRoutes(deps: MacAccountDeps): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    const match = ROUTE.exec(path);
    if (!match) return PASS;
    if (deps.cloudHome || !desktopOwner(auth)) return json(res, 403, { error: "Only this Mac's later.dog app can move its accounts." });
    res.setHeader("cache-control", "no-store");
    const list = () => macAccountSources(deps.instances(), { dataDir: deps.dataDir, held: new Set(readHeldAccounts(deps.file).keys()), env: deps.env, platform: deps.platform });
    const instanceId = match[1];
    if (!instanceId) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      return json(res, 200, { accounts: list() });
    }
    if (method !== "PUT" && method !== "DELETE") return json(res, 405, { error: "method not allowed" });
    const hold = method === "PUT";
    if (!MOVABLE_ACCOUNT_ID.test(instanceId)) return json(res, 404, { error: "This account can't move." });
    const source = list().find((candidate) => candidate.instanceId === instanceId && candidate.kind !== "chatgpt-plan");
    if (!source && hold) return json(res, 404, { error: "This account can't move." });
    const outcome = await deps.exclusive(async () => {
      if (hold && !source?.held && deps.busy(instanceId)) return "busy" as const;
      setHeldAccount(deps.file, instanceId, hold ? "cloud" : null);
      await deps.reload(instanceId);
      return "done" as const;
    });
    if (outcome === null) return json(res, 409, { code: "busy", error: "Account settings are changing. Try again in a moment." });
    if (outcome === "busy") return json(res, 409, { code: "busy", error: "A dog is using this account right now." });
    return json(res, 200, { instanceId, held: hold });
  };
}
