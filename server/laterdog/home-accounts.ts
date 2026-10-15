import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import { assertSeparateClaudeAccount } from "../claude-accounts.ts";
import type { InstanceConfig, InstanceConfigMap, ProviderSnapshot } from "../contracts.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import {
  HANDOFF_BODY_LIMIT,
  MOVABLE_ACCOUNT_ID,
  accountEmailSchema,
  accountKindOf,
  DEVICE_ID,
  claudeLoginSchema,
  codexLoginSchema,
  handoffSchema,
  loginFingerprint,
  providerAccountOf,
  refreshTokenOf,
  type AiAccountKind,
  type Handoff,
} from "./ai-account-login.ts";
import { setHeldAccount } from "./held-accounts.ts";

export interface HomeAccountDeps {
  cloudHome: boolean;
  dataDir: string;
  file: string;
  instances(): InstanceConfigMap;
  save(instanceId: string, instances: InstanceConfigMap): Promise<void>;
  reload(instanceId: string): Promise<void>;
  busy(instanceId: string): boolean;
  exclusive<T>(work: () => Promise<T>): Promise<T | null>;
  signedIn(instanceId: string): Promise<boolean | null>;
}

const ROUTE = /^\/api\/laterdog\/accounts\/([\w.-]+)$/;
const MARKER = "handoff.json";
const FILE_LIMIT = 256 * 1024;

const markerSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["claude", "codex"]),
  fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  deviceId: z.string().regex(DEVICE_ID).nullable().optional(),
  providerAccount: z.string().max(300).nullable().optional(),
  email: z.string().max(254).nullable().optional(),
});
type Marker = z.infer<typeof markerSchema>;

const credentialFile = (kind: AiAccountKind) => (kind === "claude" ? ".credentials.json" : "auth.json");

const raw = (entry: InstanceConfig | undefined): Record<string, unknown> =>
  entry?.config && typeof entry.config === "object" && !Array.isArray(entry.config) ? entry.config as Record<string, unknown> : {};

const pairedOwnerDevice = (auth: RequestAuth) => auth.kind === "session" && auth.via === "bearer" && auth.scopes.includes("admin");

function readPrivate(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > FILE_LIMIT) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readMarker(directory: string): Marker | null {
  const text = readPrivate(join(directory, MARKER));
  if (text === null) return null;
  try { return markerSchema.parse(JSON.parse(text)); } catch { return null; }
}

function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("account folder is not a plain folder");
  chmodSync(directory, 0o700);
}

const writePrivate = (path: string, data: string) => writeFileAtomic(path, data, { mode: 0o600 });

function storedLogin(directory: string, kind: AiAccountKind) {
  const text = readPrivate(join(directory, credentialFile(kind)));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (kind === "claude") {
      const login = claudeLoginSchema.safeParse((parsed as { claudeAiOauth?: unknown } | null)?.claudeAiOauth);
      return login.success ? login.data : null;
    }
    const login = codexLoginSchema.safeParse(parsed);
    return login.success ? login.data : null;
  } catch {
    return null;
  }
}

function sameDriver(kind: AiAccountKind, entry: InstanceConfig | undefined): boolean {
  if (!entry) return true;
  const config = raw(entry);
  if (config.managed) return false;
  return kind === "claude"
    ? entry.driver === "claudeAgent" && entry.access !== "api" && config.requireApiKey !== true
    : entry.driver === "codex" && config.authMode !== "chatgpt-plan";
}

function placed(kind: AiAccountKind, entry: InstanceConfig | undefined, directory: string, displayName: string, claudeCli: unknown): InstanceConfig {
  if (kind === "claude") {
    const config = raw(entry);
    return { ...(entry ?? { driver: "claudeAgent" }), displayName, config: { ...config, ...(config.cli === undefined && typeof claudeCli === "string" && claudeCli ? { cli: claudeCli } : {}), configDir: directory } };
  }
  return { ...(entry ?? { driver: "codex" }), displayName, environment: { ...entry?.environment, CODEX_HOME: directory } };
}

export function handedOverEmail(dataDir: string, instanceId: string): string | null {
  if (!MOVABLE_ACCOUNT_ID.test(instanceId)) return null;
  const email = readMarker(join(dataDir, "providers", instanceId))?.email;
  return email ? accountEmailSchema.safeParse(email).data ?? null : null;
}

export function withHandedOverEmail<T extends { instanceId: string; snapshot: ProviderSnapshot }>(dataDir: string, instance: T): T {
  const { snapshot } = instance;
  if (snapshot.authenticated !== true || snapshot.account?.email) return instance;
  const email = handedOverEmail(dataDir, instance.instanceId);
  return email ? { ...instance, snapshot: { ...snapshot, account: { ...snapshot.account, email } } } : instance;
}

export function createHomeAccountRoutes(deps: HomeAccountDeps): RouteHandler {
  const folder = (instanceId: string) => join(deps.dataDir, "providers", instanceId);

  function forgetFiles(directory: string, kind: AiAccountKind) {
    rmSync(join(directory, credentialFile(kind)), { force: true });
    rmSync(join(directory, MARKER), { force: true });
  }

  async function receive(instanceId: string, handoff: Handoff) {
    const directory = folder(instanceId);
    const fingerprint = loginFingerprint(refreshTokenOf(handoff.kind, handoff.login));
    const instances = deps.instances();
    const existing = instances[instanceId];
    if (!sameDriver(handoff.kind, existing)) return { status: 409, body: { code: "different_account", error: "My Cloud uses this name for a different account." } };
    const marker = readMarker(directory);
    const provider = providerAccountOf(handoff.kind, handoff.login, handoff.email);
    if (marker && marker.kind === handoff.kind && marker.fingerprint !== fingerprint && marker.deviceId !== handoff.deviceId) {
      const sameProviderAccount = provider !== null && marker.providerAccount === provider;
      if (!sameProviderAccount) return { status: 409, body: { code: "other_device", error: "My Cloud already holds this account's sign-in from another computer." } };
    }
    if (marker && marker.kind === handoff.kind && marker.fingerprint === fingerprint && storedLogin(directory, handoff.kind)) {
      setHeldAccount(deps.file, instanceId, null);
      await deps.reload(instanceId);
      const signedIn = await deps.signedIn(instanceId);
      return signedIn === true ? { status: 200, body: { instanceId, signedIn: true } } : { status: 422, body: { code: "not_signed_in", error: "My Cloud could not sign in with this account." } };
    }
    if (!marker && existing && await deps.signedIn(instanceId) === true) {
      return { status: 409, body: { code: "home_signed_in", error: "My Cloud already has its own sign-in for this account." } };
    }
    const entry = placed(handoff.kind, existing, directory, handoff.displayName, raw(instances.claude).cli);
    if (handoff.kind === "claude") {
      try { assertSeparateClaudeAccount(instances, instanceId, entry); } catch {
        return { status: 409, body: { code: "different_account", error: "My Cloud uses this folder for a different account." } };
      }
    }
    const created = marker ? false : !existing;
    privateDirectory(directory);
    const credential = handoff.kind === "claude" ? { claudeAiOauth: handoff.login } : handoff.login;
    writePrivate(join(directory, credentialFile(handoff.kind)), `${JSON.stringify(credential, null, 2)}\n`);
    if (handoff.kind === "codex" && !existsSync(join(directory, "config.toml"))) writePrivate(join(directory, "config.toml"), "cli_auth_credentials_store = \"file\"\n");
    writePrivate(join(directory, MARKER), `${JSON.stringify({ version: 1, kind: handoff.kind, fingerprint, deviceId: handoff.deviceId, providerAccount: provider, email: handoff.email ?? null } satisfies Marker)}\n`);
    setHeldAccount(deps.file, instanceId, null);
    const rollBack = async () => {
      forgetFiles(directory, handoff.kind);
      const now = deps.instances();
      if (created) delete now[instanceId];
      else if (existing) now[instanceId] = existing;
      await deps.save(instanceId, now);
    };
    try {
      await deps.save(instanceId, { ...instances, [instanceId]: entry });
    } catch (error) {
      await rollBack().catch(() => {});
      throw error;
    }
    if (await deps.signedIn(instanceId) !== true) {
      await rollBack();
      return { status: 422, body: { code: "not_signed_in", error: "My Cloud could not sign in with this account." } };
    }
    return { status: 200, body: { instanceId, signedIn: true } };
  }

  return async ({ req, res, path, method, auth, json, readBody }) => {
    const match = ROUTE.exec(path);
    if (!match) return PASS;
    if (!deps.cloudHome || !pairedOwnerDevice(auth)) return json(res, 403, { error: "Only your signed-in later.dog app can move accounts to My Cloud." });
    res.setHeader("cache-control", "no-store");
    const instanceId = match[1];
    if (!MOVABLE_ACCOUNT_ID.test(instanceId)) return json(res, 400, { error: "This account can't move." });
    let work: () => Promise<{ status: number; body: unknown }>;
    if (method === "PUT") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
      let body: unknown;
      try { body = await readBody(req, HANDOFF_BODY_LIMIT); } catch (error) {
        const status = (error as { status?: unknown }).status === 413 ? 413 : 400;
        return json(res, status, { error: "The account could not be read." });
      }
      const parsed = handoffSchema.safeParse(body);
      if (!parsed.success || parsed.data.kind !== accountKindOf(instanceId)) return json(res, 400, { error: "The account could not be read." });
      work = () => receive(instanceId, parsed.data);
    } else return json(res, 405, { error: "method not allowed" });
    let answer: { status: number; body: unknown } | null;
    try { answer = await deps.exclusive(work); } catch {
      return json(res, 500, { code: "failed", error: "My Cloud could not change this account." });
    }
    if (!answer) return json(res, 409, { code: "busy", error: "Account settings are changing. Try again in a moment." });
    return json(res, answer.status, answer.body);
  };
}
