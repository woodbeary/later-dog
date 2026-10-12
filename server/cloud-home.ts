import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { Surface } from "../shared/wire.ts";
import { writeFileAtomic } from "./atomic.ts";
import { hostedWorkspaceConfigured } from "./enterprise.ts";
import { formatPairingCode, type SessionRegistry } from "./sessions.ts";

export const CLOUD_HOME_KEYS = ["LATERDOG_CLOUD_ROLE", "LATERDOG_CLOUD_MACHINE_ID", "LATERDOG_CLOUD_ADMIN_URL", "LATERDOG_CLOUD_BOOTSTRAP_SECRET"] as const;
export const CLOUD_IGNORED_KEYS = ["LATERDOG_HOSTED_MODEL_URL", "LATERDOG_HOSTED_MODEL_TOKEN", "LATERDOG_HOSTED_MODELS"] as const;
export const CLOUD_PAIRING_PATH = "/api/cloud/pairing";
export const CLOUD_PAIRING_DEFAULT_TTL_S = 300;
export const CLOUD_PAIRING_MAX_TTL_S = 600;
const OWNER_EMAIL = /^[!-;=?A-~]{1,64}@[!-;=?A-~]{1,189}$/;
export const CLOUD_BROWSER_SIGN_IN_MAX_TTL_S = 120;
export const CLOUD_PAIRING_SKEW_S = 300;
export const CLOUD_PAIRING_NONCE_MS = 10 * 60_000;
const MAX_NONCES = 10_000;
export const CLOUD_HOME_MARKER = ".laterdog-cloud-home.json";

export interface CloudHomeConfig {
  machineId: string;
  adminOrigin: string;
  publicOrigin: string;
  bootstrapSecret: string;
  warnings: string[];
}

export function cloudHomeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return CLOUD_HOME_KEYS.some((key) => env[key] !== undefined);
}

function invalid(why: string): never {
  throw new Error(`Cloud home configuration is invalid: ${why}.`);
}

function exactHttpsOrigin(raw: string | undefined, name: string): string {
  let url: URL;
  try {
    if (!raw || raw !== raw.trim()) throw new Error();
    url = new URL(raw);
  } catch { return invalid(`${name} must be an https origin`); }
  if (url.protocol !== "https:" || url.username || url.password || (raw !== url.origin && raw !== `${url.origin}/`)) {
    invalid(`${name} must be an exact https origin with no path`);
  }
  return url.origin;
}

export function cloudHomeConfiguration(env: NodeJS.ProcessEnv = process.env): CloudHomeConfig | null {
  if (!cloudHomeConfigured(env)) return null;
  if (env.LATERDOG_DESKTOP_PARENT === "1") invalid("the desktop app cannot run as a Cloud home machine");
  if (hostedWorkspaceConfigured(env)) invalid("a Cloud home is not a hosted team workspace; remove LATERDOG_ADMIN_URL, LATERDOG_ADMIN_WORKSPACE and LATERDOG_ADMIN_MEMBERSHIP");
  if (env.LATERDOG_CLOUD_ROLE !== "home") invalid('LATERDOG_CLOUD_ROLE must be "home"; this image runs the home machine');
  const machineId = env.LATERDOG_CLOUD_MACHINE_ID ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(machineId)) invalid("LATERDOG_CLOUD_MACHINE_ID must be the Admin's machine id (letters, digits, dashes)");
  const adminOrigin = exactHttpsOrigin(env.LATERDOG_CLOUD_ADMIN_URL, "LATERDOG_CLOUD_ADMIN_URL");
  const publicOrigin = exactHttpsOrigin(env.LATERDOG_PUBLIC_URL, "LATERDOG_PUBLIC_URL");
  const bootstrapSecret = env.LATERDOG_CLOUD_BOOTSTRAP_SECRET ?? "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(bootstrapSecret)) invalid("LATERDOG_CLOUD_BOOTSTRAP_SECRET must be at least 256 bits of base64url");
  const warnings: string[] = [];
  const ignored = CLOUD_IGNORED_KEYS.filter((key) => env[key] !== undefined);
  if (ignored.length) warnings.push(`ignoring ${ignored.join(", ")}: Cloud Pro includes no AI; people sign in with their own Claude or ChatGPT account, or an API key`);
  return { machineId, adminOrigin, publicOrigin, bootstrapSecret, warnings };
}

export { CLOUD_HOME_SECRET_KEYS, CLOUD_SECRETS_FD_ENV, cloudHomeSecrets, takeCloudSecrets, withoutCloudSecrets } from "./cloud-secrets.ts";

export function withoutIgnoredCloudKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = { ...env };
  for (const key of CLOUD_IGNORED_KEYS) delete kept[key];
  return kept;
}

export { cloudHomeOffersPlace } from "../shared/cloud-home.ts";

export function cloudHomePlaceRefusal(place: Surface): string | undefined {
  if (place === "local") return "This computer isn't a place on My Cloud. Set Works on to Auto or Cloud computer.";
  if (place === "vm") return "Dogs on My Cloud can't use a Local VM. Set Works on to Auto or Cloud computer.";
  return undefined;
}

export function firstCloudTurnPatch(turn: { cloudHome: boolean; recorded: string | undefined; ok: boolean; known: boolean; now?: Date }): { onboarding: { firstTurnAt: string } } | null {
  if (!turn.cloudHome || turn.recorded || !turn.ok || !turn.known) return null;
  return { onboarding: { firstTurnAt: (turn.now ?? new Date()).toISOString() } };
}

export function cloudPairingSignature(secret: string, timestamp: string, nonce: string, body: Buffer | string): string {
  const bodyHash = createHash("sha256").update(body).digest("base64url");
  return createHmac("sha256", secret).update(`v1\n${timestamp}\n${nonce}\nPOST\n${CLOUD_PAIRING_PATH}\n${bodyHash}`).digest("base64url");
}

export interface CloudPairingResult {
  status: 200 | 400 | 401 | 429 | 503;
  body: Record<string, unknown>;
}

type PairingSessions = Pick<SessionRegistry, "openPairing" | "attemptAllowed" | "noteFailure" | "clearFailures">;

export function createCloudPairing(options: {
  secret: string;
  sessions: PairingSessions;
  now?: () => number;
}) {
  const { secret, sessions } = options;
  const now = options.now ?? Date.now;
  const nonces = new Map<string, number>();
  const refused = (error: string): CloudPairingResult => ({ status: 401, body: { error } });
  return {
    handle(input: { timestamp: string | undefined; nonce: string | undefined; signature: string | undefined; body: Buffer; source: string }): CloudPairingResult {
      const lock = sessions.attemptAllowed(input.source);
      if (!lock.ok) return { status: 429, body: { error: "rate_limited", retryAfterSeconds: Math.ceil(lock.retryAfterMs / 1000) } };
      const timestamp = input.timestamp ?? "", nonce = input.nonce ?? "";
      const presented = /^v1=([A-Za-z0-9_-]{43})$/.exec(input.signature ?? "")?.[1];
      const expected = Buffer.from(cloudPairingSignature(secret, timestamp, nonce, input.body), "base64url");
      const given = presented ? Buffer.from(presented, "base64url") : Buffer.alloc(expected.length);
      const matches = given.length === expected.length && timingSafeEqual(given, expected);
      if (!presented || !matches || !/^\d{1,12}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
        sessions.noteFailure(input.source);
        return refused("invalid_signature");
      }
      sessions.clearFailures(input.source);
      const at = now();
      if (Math.abs(at / 1000 - Number(timestamp)) > CLOUD_PAIRING_SKEW_S) return refused("stale_request");
      for (const [seen, until] of nonces) if (until <= at) nonces.delete(seen);
      if (nonces.has(nonce)) return refused("replayed_request");
      if (nonces.size >= MAX_NONCES) return { status: 503, body: { error: "busy" } };
      nonces.set(nonce, at + CLOUD_PAIRING_NONCE_MS);
      let parsed: unknown;
      try { parsed = input.body.length ? JSON.parse(input.body.toString("utf8")) : {}; } catch { return { status: 400, body: { error: "invalid_body" } }; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: 400, body: { error: "invalid_body" } };
      const { label, ttlSeconds, purpose, owner } = parsed as { label?: unknown; ttlSeconds?: unknown; purpose?: unknown; owner?: unknown };
      // oxlint-disable-next-line no-control-regex
      if (label !== undefined && (typeof label !== "string" || label.length > 80 || /[\x00-\x1f\x7f]/.test(label))) return { status: 400, body: { error: "invalid_label" } };
      if (ttlSeconds !== undefined && (!Number.isSafeInteger(ttlSeconds) || (ttlSeconds as number) < 1)) return { status: 400, body: { error: "invalid_ttl" } };
      if (purpose !== undefined && purpose !== "browser") return { status: 400, body: { error: "invalid_purpose" } };
      const browser = purpose === "browser";
      if ((browser || owner !== undefined) && (typeof owner !== "string" || owner.length > 254 || !OWNER_EMAIL.test(owner))) {
        return { status: 400, body: { error: "invalid_owner" } };
      }
      const ttl = Math.min((ttlSeconds as number | undefined) ?? CLOUD_PAIRING_DEFAULT_TTL_S, browser ? CLOUD_BROWSER_SIGN_IN_MAX_TTL_S : CLOUD_PAIRING_MAX_TTL_S);
      const opened = sessions.openPairing({
        scopes: ["admin", "client"],
        label: typeof label === "string" && label.trim() ? label.trim() : "later.dog Cloud",
        ttlMs: ttl * 1000,
        browser,
        ...(browser ? { owner: owner as string } : {}),
      });
      if (browser) return { status: 200, body: { credential: opened.credential, expiresAt: opened.expiresAt, purpose: "browser" } };
      return { status: 200, body: { code: formatPairingCode(opened.code), credential: opened.credential, expiresAt: opened.expiresAt } };
    },
  };
}

export function readSignedBody(req: IncomingMessage, limit = 4096): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) { done = true; reject(Object.assign(new Error("body too large"), { status: 413 })); return; }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on("error", (error) => { if (!done) { done = true; reject(Object.assign(error, { status: 400 })); } });
  });
}

const ADOPTABLE = new Set(["lost+found", ".bash_logout", ".bashrc", ".profile"]);

export function prepareCloudHomeVolume(home: string, machineId: string): "new" | "existing" {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const marker = join(home, CLOUD_HOME_MARKER);
  if (existsSync(marker)) {
    const stat = lstatSync(marker);
    let saved: unknown;
    try {
      if (!stat.isFile() || stat.size > 4096) throw new Error();
      saved = JSON.parse(readFileSync(marker, "utf8"));
    } catch { throw new Error("This volume's Cloud marker is unreadable. No data was changed."); }
    if ((saved as { machine?: unknown })?.machine !== machineId) throw new Error("This volume belongs to another Cloud machine. No data was changed.");
    return "existing";
  }
  if (readdirSync(home).some((name) => !ADOPTABLE.has(name))) {
    throw new Error("Refusing to adopt a data volume that was not made for this Cloud machine. No data was changed.");
  }
  writeFileAtomic(marker, JSON.stringify({ version: 1, machine: machineId }) + "\n", { mode: 0o600 });
  return "new";
}

export function cloudHomeHost(config: Pick<CloudHomeConfig, "publicOrigin">): string {
  return new URL(config.publicOrigin).hostname;
}
