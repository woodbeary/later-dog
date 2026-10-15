import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { join } from "node:path";

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
export const CLAUDE_KEYCHAIN_FALLBACK_ACCOUNT = "claude-code-user";
const KEYCHAIN_ACCOUNT = /^[a-zA-Z0-9._-]+$/;

export interface ClaudeStorageEnv {
  CLAUDE_CONFIG_DIR?: string;
  CLAUDE_SECURESTORAGE_CONFIG_DIR?: string;
}

export function claudeKeychainService(env: ClaudeStorageEnv): string {
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const directory = secure !== undefined ? secure : env.CLAUDE_CONFIG_DIR;
  if (!directory) return CLAUDE_KEYCHAIN_SERVICE;
  return `${CLAUDE_KEYCHAIN_SERVICE}-${createHash("sha256").update(directory.normalize("NFC")).digest("hex").slice(0, 8)}`;
}

export function claudeKeychainAccount(env: { USER?: string }, username: () => string = () => userInfo().username): string {
  let name: string;
  try { name = env.USER || username(); } catch { return CLAUDE_KEYCHAIN_FALLBACK_ACCOUNT; }
  return KEYCHAIN_ACCOUNT.test(name) ? name : CLAUDE_KEYCHAIN_FALLBACK_ACCOUNT;
}

export function claudeCredentialsFile(env: ClaudeStorageEnv, home: string): string {
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const directory = secure !== undefined ? secure || join(home, ".claude") : env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  return join(directory.normalize("NFC"), ".credentials.json");
}
