import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { interruptibleDelay } from "../drivers/retry.ts";
import { claudeCredentialsFile } from "./claude-keychain.ts";

export const CLAUDE_REFRESH_LOCK_STALE_MS = 60_000;
export const CLAUDE_REFRESH_LOCK_RETRY_DELAYS_MS: readonly number[] = [15_000, 35_000];
export const CLAUDE_REFRESH_MARGIN_MS = 5 * 60_000;
export const CLAUDE_REFRESH_LEAD_MS = 20_000;
const CLAUDE_REFRESH_POLL_MS = 250;
const CREDENTIALS_LIMIT = 64 * 1024;
const REFRESH_LOCK_WORDS = /another Claude Code process is (?:refreshing it|holding the refresh lock)/i;
const ACCOUNT_TOKEN_ENV = ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

export interface RefreshLockState {
  failed: boolean;
  retries: number;
}

export interface RefreshLockRetry {
  delayScale: number;
  signal: AbortSignal;
  stillWaiting(): boolean;
  resend(): Promise<boolean>;
  resendFailed(): void;
}

export function claudeRefreshLockWords(text: unknown): boolean {
  return typeof text === "string" && REFRESH_LOCK_WORDS.test(text);
}

export function claudeRefreshLockFrame(frame: { error?: unknown; is_api_error_message?: unknown }, text: string): boolean {
  if (frame.is_api_error_message !== true && typeof frame.error !== "string") return false;
  return claudeRefreshLockWords(text);
}

export function claudeRefreshLockResult(frame: { is_error?: unknown; result?: unknown }): boolean {
  return frame.is_error === true && claudeRefreshLockWords(frame.result);
}

export function claudeSignInAgainMessage(account: string | undefined): string {
  const name = account?.trim();
  return name ? `${name} needs signing in again.` : "This Claude account needs signing in again.";
}

export function retryClaudeRefreshLock(state: RefreshLockState, retry: RefreshLockRetry): boolean {
  state.failed = false;
  const delayMs = CLAUDE_REFRESH_LOCK_RETRY_DELAYS_MS[state.retries];
  if (delayMs === undefined) return false;
  state.retries += 1;
  void interruptibleDelay(delayMs * retry.delayScale, retry.signal).promise.then(async (outcome) => {
    if (outcome === "cancelled" || !retry.stillWaiting()) return;
    let sent = false;
    try {
      sent = await retry.resend();
    } catch {
      sent = false;
    }
    if (!sent && retry.stillWaiting()) retry.resendFailed();
  });
  return true;
}

export function claudeTokenExpiry(file: string): number | null {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > CREDENTIALS_LIMIT) return null;
    const saved = JSON.parse(readFileSync(file, "utf8")) as { claudeAiOauth?: { expiresAt?: unknown } } | null;
    const expiresAt = saved?.claudeAiOauth?.expiresAt;
    return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null;
  } catch {
    return null;
  }
}

export interface ClaudeRefreshGateOptions {
  platform?: NodeJS.Platform;
  now?: () => number;
  expiry?: (file: string) => number | null;
  leadMs?: number;
  pollMs?: number;
}

export interface ClaudeRefreshGate {
  enter(env: NodeJS.ProcessEnv): Promise<void>;
}

export function createClaudeRefreshGate(options: ClaudeRefreshGateOptions = {}): ClaudeRefreshGate {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const expiry = options.expiry ?? claudeTokenExpiry;
  const leadMs = options.leadMs ?? CLAUDE_REFRESH_LEAD_MS;
  const pollMs = options.pollMs ?? CLAUDE_REFRESH_POLL_MS;
  const leads = new Map<string, Promise<void>>();
  const due = (file: string) => {
    const expiresAt = expiry(file);
    return expiresAt !== null && expiresAt - now() <= CLAUDE_REFRESH_MARGIN_MS;
  };
  const lead = (file: string) => {
    const started = now();
    const refreshed = new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (due(file) && now() - started < leadMs) return;
        clearInterval(poll);
        resolve();
      }, pollMs);
      poll.unref?.();
    }).finally(() => {
      if (leads.get(file) === refreshed) leads.delete(file);
    });
    leads.set(file, refreshed);
  };
  return {
    async enter(env) {
      if (platform !== "linux") return;
      if (ACCOUNT_TOKEN_ENV.some((key) => env[key])) return;
      let file: string;
      try {
        file = claudeCredentialsFile(env, env.HOME || env.USERPROFILE || homedir());
      } catch {
        return;
      }
      const running = leads.get(file);
      if (running) return running;
      if (due(file)) lead(file);
    },
  };
}

export const claudeRefreshGate = createClaudeRefreshGate();
