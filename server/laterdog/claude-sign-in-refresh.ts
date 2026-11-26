import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { claudeCredentialsFile } from "./claude-keychain.ts";
import { keepSignIn, type SignInKeep } from "./account-sign-ins.ts";

export interface ClaudeAccountRenewal { command: string; env: Record<string, string> }

export const CLAUDE_SIGN_IN_CHECK_MODEL = "laterdog-sign-in-check";
export const CLAUDE_SIGN_IN_CHECK_ARGS: readonly string[] = [
  "-p", "--model", CLAUDE_SIGN_IN_CHECK_MODEL, "--max-turns", "1", "--tools", "", "--strict-mcp-config",
  "--no-session-persistence", "--output-format", "json", "ok",
];
export const CLAUDE_RENEW_WHEN_LEFT_MS = 4.5 * 60_000;
export const CLAUDE_LEND_MIN_LEFT_MS = 2 * 60_000;
export const CLAUDE_SIGN_IN_CHECK_TIMEOUT_MS = 90_000;
const CREDENTIALS_LIMIT = 64 * 1024;
const ACCOUNT_TOKEN_ENV = ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR"] as const;

export type SavedClaudeSignIn = { kind: "none" } | { kind: "token"; expiresAt: number; refreshable: boolean };

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

export function claudeSignIn(renewal: ClaudeAccountRenewal, run: (renewal: ClaudeAccountRenewal) => Promise<void> = runClaudeSignInCheck): SignInKeep {
  const file = claudeAccountFile(renewal);
  return {
    leftMs: CLAUDE_RENEW_WHEN_LEFT_MS,
    async read() {
      if (!file) return { kind: "key" };
      const saved = readSavedClaudeSignIn(file);
      return saved.kind === "none" ? saved : { kind: "token", expiresAt: saved.expiresAt, refreshable: saved.refreshable };
    },
    renew: () => run(renewal),
  };
}

export const renewClaudeSignIn = (renewal: ClaudeAccountRenewal) => keepSignIn(claudeSignIn(renewal));
