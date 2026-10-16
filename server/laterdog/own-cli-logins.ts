import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { codexHome } from "../drivers/codex-identity.ts";
import { userHome } from "../env-path.ts";
import { claudeCredentialsFile, claudeKeychainService, type ClaudeStorageEnv } from "./claude-keychain.ts";

const CLAUDE_CONFIG_LIMIT = 8 * 1024 * 1024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Env = Record<string, string | undefined>;

function ownClaudeStorages(env: Env): ClaudeStorageEnv[] {
  return [
    { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR || undefined, CLAUDE_SECURESTORAGE_CONFIG_DIR: env.CLAUDE_SECURESTORAGE_CONFIG_DIR },
    {},
  ];
}

export function claudeLoginIsOwnCli(storage: ClaudeStorageEnv, env: Env): boolean {
  const home = userHome(env);
  const file = claudeCredentialsFile(storage, home);
  const service = claudeKeychainService(storage);
  return ownClaudeStorages(env).some((own) => claudeCredentialsFile(own, home) === file || claudeKeychainService(own) === service);
}

export function codexLoginIsOwnCli(home: string, env: Env): boolean {
  const own = [codexHome({ ...env }), join(userHome(env), ".codex")].filter((path): path is string => Boolean(path)).map((path) => resolve(path));
  return own.includes(resolve(home));
}

export function plainEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  return email.length <= 254 && EMAIL.test(email) && !/[\p{Cc}\p{Cf}]/u.test(email) ? email : null;
}

export function claudeAccountEmail(directory: string): string | null {
  const file = join(directory, ".claude.json");
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > CLAUDE_CONFIG_LIMIT) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { oauthAccount?: { emailAddress?: unknown } | null } | null;
    return plainEmail(parsed?.oauthAccount?.emailAddress);
  } catch {
    return null;
  }
}
