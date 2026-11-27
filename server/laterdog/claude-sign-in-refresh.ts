import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { claudeCredentialsFile } from "./claude-keychain.ts";

export interface ClaudeAccountRenewal { command: string; env: Record<string, string> }

export const CLAUDE_SIGN_IN_CHECK_MODEL = "laterdog-sign-in-check";
export const CLAUDE_SIGN_IN_CHECK_ARGS: readonly string[] = [
  "-p", "--model", CLAUDE_SIGN_IN_CHECK_MODEL, "--max-turns", "1", "--tools", "", "--strict-mcp-config",
  "--no-session-persistence", "--output-format", "json", "ok",
];
export const CLAUDE_RENEW_WHEN_LEFT_MS = 4.5 * 60_000;
export const CLAUDE_LEND_MIN_LEFT_MS = 2 * 60_000;
export const CLAUDE_KEEP_FRESH_EVERY_MS = 60_000;
export const CLAUDE_SIGN_IN_CHECK_TIMEOUT_MS = 90_000;
const CREDENTIALS_LIMIT = 64 * 1024;
const ACCOUNT_TOKEN_ENV = ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR"] as const;

export type SavedClaudeSignIn = { kind: "none" } | { kind: "token"; expiresAt: number; refreshable: boolean };
export type ClaudeSignInOutcome = "fresh" | "renewed" | "signed-out" | "unrenewed";

export function readSavedClaudeSignIn(file: string): SavedClaudeSignIn {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > CREDENTIALS_LIMIT) return { kind: "none" };
    const oauth = (JSON.parse(readFileSync(file, "utf8")) as { claudeAiOauth?: Record<string, unknown> } | null)?.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken || typeof oauth.expiresAt !== "number" || !Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= 0) return { kind: "none" };
    return { kind: "token", expiresAt: oauth.expiresAt, refreshable: typeof oauth.refreshToken === "string" && oauth.refreshToken.length > 0 };
  } catch {
    return { kind: "none" };
  }
}

export function claudeAccountFile(renewal: ClaudeAccountRenewal): string | null {
  if (ACCOUNT_TOKEN_ENV.some(key => renewal.env[key])) return null;
  return claudeCredentialsFile(renewal.env, renewal.env.HOME || homedir());
}

export function runClaudeSignInCheck(renewal: ClaudeAccountRenewal, timeoutMs = CLAUDE_SIGN_IN_CHECK_TIMEOUT_MS): Promise<void> {
  const file = claudeAccountFile(renewal);
  return new Promise(resolve => {
    try {
      execFile(renewal.command, [...CLAUDE_SIGN_IN_CHECK_ARGS], {
        env: renewal.env, cwd: file ? dirname(file) : undefined, timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true,
      }, () => resolve());
    } catch {
      resolve();
    }
  });
}

export function plainEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export interface ClaudeSignInRefreshOptions {
  run?: (renewal: ClaudeAccountRenewal) => Promise<void>;
  read?: (file: string) => SavedClaudeSignIn;
  now?: () => number;
  renewWhenLeftMs?: number;
  lendMinLeftMs?: number;
  everyMs?: number;
  enabled?: () => boolean;
  changed?: (instanceId: string) => void;
}

export interface ClaudeSignInRefresh {
  ensure(instanceId: string, renewal: ClaudeAccountRenewal): Promise<ClaudeSignInOutcome>;
  watch(instanceId: string, renewal: () => ClaudeAccountRenewal | null): () => void;
  check(): Promise<void>;
  signedOut(instanceId: string): boolean;
  onChange(listener: (instanceId: string) => void): void;
}

export function createClaudeSignInRefresh(options: ClaudeSignInRefreshOptions = {}): ClaudeSignInRefresh {
  const run = options.run ?? (renewal => runClaudeSignInCheck(renewal));
  const read = options.read ?? readSavedClaudeSignIn;
  const now = options.now ?? Date.now;
  const renewWhenLeftMs = options.renewWhenLeftMs ?? CLAUDE_RENEW_WHEN_LEFT_MS;
  const lendMinLeftMs = options.lendMinLeftMs ?? CLAUDE_LEND_MIN_LEFT_MS;
  const everyMs = options.everyMs ?? CLAUDE_KEEP_FRESH_EVERY_MS;
  const enabled = options.enabled ?? (() => true);
  const running = new Map<string, Promise<ClaudeSignInOutcome>>();
  const outOf = new Map<string, string>();
  const watched = new Map<string, () => ClaudeAccountRenewal | null>();
  const listeners = new Set<(instanceId: string) => void>();
  if (options.changed) listeners.add(options.changed);
  let timer: NodeJS.Timeout | null = null;

  const record = (instanceId: string, file: string, outcome: ClaudeSignInOutcome) => {
    const was = outOf.get(instanceId) === file;
    if (outcome === "signed-out") outOf.set(instanceId, file);
    else if (outcome !== "unrenewed") outOf.delete(instanceId);
    if (was !== (outOf.get(instanceId) === file)) for (const listener of listeners) listener(instanceId);
    return outcome;
  };

  const judge = (saved: SavedClaudeSignIn): ClaudeSignInOutcome | null => {
    if (saved.kind === "none") return "signed-out";
    if (saved.expiresAt - now() > renewWhenLeftMs) return "fresh";
    if (!saved.refreshable) return saved.expiresAt - now() > lendMinLeftMs ? "fresh" : "signed-out";
    return null;
  };

  const renew = (file: string, renewal: ClaudeAccountRenewal): Promise<ClaudeSignInOutcome> => {
    const current = running.get(file);
    if (current) return current;
    const started = (async (): Promise<ClaudeSignInOutcome> => {
      const before = judge(read(file));
      if (before) return before;
      try { await run(renewal); } catch {}
      const after = read(file);
      const settled = judge(after);
      if (settled === "fresh") return "renewed";
      if (settled === "signed-out" || after.kind === "none" || (after.kind === "token" && !after.refreshable)) return "signed-out";
      return "unrenewed";
    })().finally(() => { if (running.get(file) === started) running.delete(file); });
    running.set(file, started);
    return started;
  };

  const ensure = async (instanceId: string, renewal: ClaudeAccountRenewal): Promise<ClaudeSignInOutcome> => {
    const file = enabled() ? claudeAccountFile(renewal) : null;
    if (!file) return "fresh";
    return record(instanceId, file, await renew(file, renewal));
  };

  const check = async () => {
    if (!enabled()) return;
    await Promise.all([...watched].map(async ([instanceId, renewalFor]) => {
      let renewal: ClaudeAccountRenewal | null;
      try { renewal = renewalFor(); } catch { return; }
      const file = renewal && claudeAccountFile(renewal);
      if (!renewal || !file) return;
      const saved = read(file);
      if (saved.kind === "none") return;
      await ensure(instanceId, renewal);
    }));
  };

  return {
    ensure,
    check,
    watch(instanceId, renewal) {
      watched.set(instanceId, renewal);
      if (!timer) {
        timer = setInterval(() => { void check(); }, everyMs);
        timer.unref?.();
      }
      return () => {
        if (watched.get(instanceId) === renewal) watched.delete(instanceId);
        outOf.delete(instanceId);
        if (!watched.size && timer) { clearInterval(timer); timer = null; }
      };
    },
    onChange(listener) { listeners.add(listener); },
    signedOut(instanceId) {
      const file = outOf.get(instanceId);
      if (!file) return false;
      const saved = read(file);
      return saved.kind === "none" || saved.expiresAt - now() <= lendMinLeftMs;
    },
  };
}

export const claudeSignInRefresh = createClaudeSignInRefresh({
  enabled: () => process.env.LATERDOG_CLOUD_ROLE === "home" && process.platform === "linux",
});
