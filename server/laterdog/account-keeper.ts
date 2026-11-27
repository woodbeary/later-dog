import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import type { InstanceConfigMap } from "../contracts.ts";
import { codexAccountEmail, codexHome } from "../drivers/codex-identity.ts";
import { grokHome } from "../drivers/acp/grok.ts";
import { splitCliString } from "../env-path.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import type { RequestAuth } from "../request-auth.ts";
import { claudeCredentialsFile } from "./claude-keychain.ts";
import { readSavedClaudeSignIn } from "./claude-sign-in-refresh.ts";
import { currentGrokLogin } from "./guest-grok-login.ts";

export type KeptKind = "claude" | "codex" | "grok";
export type SignInState = "fresh" | "renewed" | "failing" | "signed-out" | "missing";

export interface SavedSignIn { expiresAt: number | null; refreshable: boolean; renewedAt?: number | null }

export interface KeptAccount {
  instanceId: string;
  kind: KeptKind;
  handedOver: boolean;
  read(): SavedSignIn | null;
  renew?(earlyBy: number): Promise<void>;
  renewsEarly?: boolean;
}

export interface SignInStatus {
  instanceId: string;
  kind: KeptKind;
  state: SignInState;
  expiresAt: number | null;
  checkedAt: number;
  renewedAt: number | null;
  failures: number;
  handedOver: boolean;
  reason?: string;
}

export const KEEPER_EVERY_MS = 10 * 60_000;
export const KEEPER_FIRST_AFTER_MS = 90_000;
export const KEEPER_RENEW_WHEN_LEFT_MS = 2 * 60 * 60_000;
export const KEEPER_RENEW_AFTER_AGE_MS = 7 * 24 * 60 * 60_000;
export const KEEPER_RETRY_MS = 30 * 60_000;
const FILE_LIMIT = 1024 * 1024;

const REASON: Record<SignInState, string | undefined> = {
  fresh: undefined,
  renewed: undefined,
  missing: "No sign-in is saved for this account on your Cloud.",
  failing: "Renewing this sign-in failed once. later.dog tries again before it counts it as signed out.",
  "signed-out": "This sign-in could not be renewed twice in a row. Sign in to this account again.",
};
const HANDED_OVER = "This sign-in came from a Mac. If that Mac still uses the same account, each side renewing it can sign the other out; sign in here directly instead.";

const flights = new Map<string, Promise<unknown>>();
export function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const running = flights.get(key) as Promise<T> | undefined;
  if (running) return running;
  const started = work().finally(() => { if (flights.get(key) === started) flights.delete(key); });
  flights.set(key, started);
  return started;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > FILE_LIMIT) return null;
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const ms = (value: unknown): number | null => {
  const at = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at > 0 ? at : null;
};

export function jwtExpiry(token: unknown): number | null {
  if (typeof token !== "string") return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try { return ms(record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).exp); } catch { return null; }
}

export function readCodexSignIn(home: string): SavedSignIn | null {
  const auth = readJson(join(home, "auth.json"));
  if (!auth || (auth.auth_mode !== undefined && auth.auth_mode !== "chatgpt")) return null;
  const tokens = record(auth.tokens);
  if (typeof tokens.access_token !== "string" || !tokens.access_token) return null;
  return { expiresAt: jwtExpiry(tokens.access_token), refreshable: typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0, renewedAt: ms(auth.last_refresh) };
}

export function readGrokSignIn(file: string): SavedSignIn | null {
  const auth = readJson(file);
  if (!auth) return null;
  const entries = Object.values(auth).map(record).filter(entry => typeof entry.key === "string" && entry.key);
  if (entries.length !== 1) return null;
  const entry = entries[0]!;
  return { expiresAt: ms(entry.expires_at), refreshable: typeof entry.refresh_token === "string" && entry.refresh_token.length > 0 };
}

export function renewCodex(cli: string, env: Record<string, string | undefined>): Promise<boolean> {
  const home = codexHome(env);
  if (!home) return Promise.resolve(false);
  return oneAtATime(`codex:${home}`, async () => Boolean(await codexAccountEmail(cli, env, 30_000, true)));
}

export function due(saved: SavedSignIn, now: number, leftMs = KEEPER_RENEW_WHEN_LEFT_MS, ageMs = KEEPER_RENEW_AFTER_AGE_MS): boolean {
  if (saved.expiresAt !== null && saved.expiresAt - now <= leftMs) return true;
  return saved.renewedAt !== undefined && saved.renewedAt !== null && now - saved.renewedAt >= ageMs;
}

export interface AccountKeeperOptions {
  accounts(): KeptAccount[];
  now?: () => number;
  everyMs?: number;
  firstAfterMs?: number;
  leftMs?: number;
  ageMs?: number;
  retryMs?: number;
  renewing?: () => boolean;
}

export interface AccountKeeper {
  start(): () => void;
  check(): Promise<void>;
  renew(instanceId: string): Promise<SignInStatus | null>;
  status(): SignInStatus[];
  signedOut(instanceId: string): boolean;
  onChange(listener: (instanceId: string) => void): void;
}

export function createAccountKeeper(options: AccountKeeperOptions): AccountKeeper {
  const now = options.now ?? Date.now;
  const everyMs = options.everyMs ?? KEEPER_EVERY_MS;
  const firstAfterMs = options.firstAfterMs ?? KEEPER_FIRST_AFTER_MS;
  const leftMs = options.leftMs ?? KEEPER_RENEW_WHEN_LEFT_MS;
  const ageMs = options.ageMs ?? KEEPER_RENEW_AFTER_AGE_MS;
  const retryMs = options.retryMs ?? KEEPER_RETRY_MS;
  const renewing = options.renewing ?? (() => true);
  const statuses = new Map<string, SignInStatus>();
  const triedAt = new Map<string, number>();
  const listeners = new Set<(instanceId: string) => void>();
  let checking: Promise<void> | null = null;

  const publish = (next: SignInStatus) => {
    const before = statuses.get(next.instanceId);
    statuses.set(next.instanceId, next);
    if (before?.state !== next.state) for (const listener of listeners) listener(next.instanceId);
    return next;
  };

  const judge = (account: KeptAccount, saved: SavedSignIn | null, renewedAt: number | null, failures: number): SignInStatus => {
    const at = now();
    const expired = saved?.expiresAt !== undefined && saved.expiresAt !== null && saved.expiresAt <= at;
    const state: SignInState = !saved ? "missing"
      : expired ? (!account.renew || !saved.refreshable || failures >= 2 ? "signed-out" : "failing")
      : failures ? "failing" : renewedAt !== null ? "renewed" : "fresh";
    const reason = [REASON[state], state !== "fresh" && state !== "renewed" && account.handedOver ? HANDED_OVER : undefined].filter(Boolean).join(" ") || undefined;
    return { instanceId: account.instanceId, kind: account.kind, state, expiresAt: saved?.expiresAt ?? null, checkedAt: at, renewedAt, failures, handedOver: account.handedOver, ...(reason ? { reason } : {}) };
  };

  const expiredAt = (saved: SavedSignIn | null) => saved?.expiresAt !== undefined && saved.expiresAt !== null && saved.expiresAt <= now();

  const keep = async (account: KeptAccount, force: boolean): Promise<SignInStatus> => {
    const previous = statuses.get(account.instanceId);
    const failed = previous?.failures ?? 0;
    const renewedAt = previous?.renewedAt ?? null;
    const saved = account.read();
    if (!saved || !account.renew || !saved.refreshable || !renewing() || !(force || due(saved, now(), leftMs, ageMs))) {
      return publish(judge(account, saved, renewedAt, expiredAt(saved) ? failed : 0));
    }
    const last = triedAt.get(account.instanceId);
    if (!force && failed && last !== undefined && now() - last < retryMs) return publish(judge(account, saved, renewedAt, failed));
    triedAt.set(account.instanceId, now());
    try { await account.renew(leftMs); } catch {}
    const after = account.read();
    const improved = Boolean(after && !expiredAt(after) && (after.expiresAt !== saved.expiresAt || (after.renewedAt ?? null) !== (saved.renewedAt ?? null)));
    const counted = improved ? 0 : account.renewsEarly || expiredAt(after) ? failed + 1 : failed;
    return publish(judge(account, after, improved ? now() : renewedAt, counted));
  };

  const check = () => checking ??= (async () => {
    let accounts: KeptAccount[];
    try { accounts = options.accounts(); } catch { return; }
    const present = new Set(accounts.map(account => account.instanceId));
    for (const id of statuses.keys()) if (!present.has(id)) statuses.delete(id);
    for (const account of accounts) {
      try { await oneAtATime(`keep:${account.instanceId}`, () => keep(account, false)); } catch {}
    }
  })().finally(() => { checking = null; });

  return {
    start() {
      const first = setTimeout(() => { void check(); }, firstAfterMs);
      const timer = setInterval(() => { void check(); }, everyMs);
      first.unref?.();
      timer.unref?.();
      return () => { clearTimeout(first); clearInterval(timer); };
    },
    check,
    async renew(instanceId) {
      const account = options.accounts().find(candidate => candidate.instanceId === instanceId);
      return account ? oneAtATime(`keep:${instanceId}`, () => keep(account, true)) : null;
    },
    status: () => [...statuses.values()].sort((a, b) => a.instanceId.localeCompare(b.instanceId)),
    signedOut: (instanceId) => {
      const status = statuses.get(instanceId);
      return status?.state === "signed-out" && status.kind !== "claude";
    },
    onChange(listener) { listeners.add(listener); },
  };
}

const configOf = (value: unknown): Record<string, unknown> => record(value);

export function keptAccounts(instances: InstanceConfigMap, held: (instanceId: string) => boolean, dataDir: string, base: NodeJS.ProcessEnv = process.env): KeptAccount[] {
  const out: KeptAccount[] = [];
  for (const [instanceId, entry] of Object.entries(instances)) {
    const config = configOf(entry.config);
    if (entry.enabled === false || entry.access === "api" || config.requireApiKey === true || config.managed || held(instanceId)) continue;
    const env: Record<string, string | undefined> = { ...base, ...entry.environment };
    const handedOver = existsSync(join(dataDir, "providers", instanceId, "handoff.json"));
    const cli = typeof config.cli === "string" && config.cli.trim() ? config.cli : undefined;
    if (entry.driver === "claudeAgent") {
      const home = env.HOME || homedir();
      const file = claudeCredentialsFile({ ...env, ...(typeof config.configDir === "string" ? { CLAUDE_CONFIG_DIR: config.configDir } : {}) }, home);
      out.push({ instanceId, kind: "claude", handedOver, read: () => {
        const saved = readSavedClaudeSignIn(file);
        return saved.kind === "token" ? { expiresAt: saved.expiresAt, refreshable: saved.refreshable } : null;
      } });
    } else if (entry.driver === "codex" && config.authMode !== "chatgpt-plan") {
      const home = codexHome(env);
      if (!home) continue;
      const command = cli ?? "codex";
      out.push({ instanceId, kind: "codex", handedOver, read: () => readCodexSignIn(home), renewsEarly: true, renew: async () => { await renewCodex(command, env); } });
    } else if (entry.driver === "grokAgent") {
      const file = join(grokHome(env), "auth.json");
      const binary = splitCliString(cli ?? "grok")[0];
      out.push({ instanceId, kind: "grok", handedOver, read: () => readGrokSignIn(file), renew: async (earlyBy) => {
        if (binary) await currentGrokLogin(file, binary, Date.now() + earlyBy);
      } });
    }
  }
  return out;
}

export function keeperRenewing(file: string): boolean {
  return readJson(file)?.renew === true;
}

export function createSignInRoutes(deps: { keeper: AccountKeeper; file: string; allowed(auth: RequestAuth): boolean }): RouteHandler {
  const view = () => ({ renewing: keeperRenewing(deps.file), accounts: deps.keeper.status() });
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/laterdog/sign-ins") return PASS;
    if (!deps.allowed(auth)) return json(res, 403, { error: "Only the owner can see sign-ins." });
    res.setHeader("cache-control", "no-store");
    if (method === "GET") return json(res, 200, view());
    if (method === "POST") {
      await deps.keeper.check();
      return json(res, 200, view());
    }
    if (method === "PUT") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
      const body = record(await readBody(req, 1024).catch(() => null));
      if (typeof body.renew !== "boolean") return json(res, 400, { error: "renew must be true or false" });
      mkdirSync(dirname(deps.file), { recursive: true, mode: 0o700 });
      writeFileAtomic(deps.file, `${JSON.stringify({ renew: body.renew })}\n`, { mode: 0o600 });
      return json(res, 200, view());
    }
    return json(res, 405, { error: "method not allowed" });
  };
}
