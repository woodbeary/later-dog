import { envSwitchedOn } from "./native-compaction.ts";

export const CLAUDE_PICKS_CACHE_LIFETIME = [2, 1, 316] as const;

const PAID_PER_TOKEN = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"] as const;
const ACCOUNT_CHOSE = ["CLAUDE_CODE_PROMPT_CACHE_TTL", "ENABLE_PROMPT_CACHING_1H", "FORCE_PROMPT_CACHING_5M"] as const;

export interface ClaudeAccountSettings {
  env?: Record<string, string>;
  apiKeyHelper?: string;
}


export function paysPerTokenForCache(env: NodeJS.ProcessEnv, account: ClaudeAccountSettings = {}): boolean {
  if (account.apiKeyHelper?.trim()) return true;
  return PAID_PER_TOKEN.some((name) => envSwitchedOn(env[name]) || envSwitchedOn(account.env?.[name]));
}

export function claudeCacheLifetime(env: NodeJS.ProcessEnv, cliPicksLifetime: boolean, account: ClaudeAccountSettings = {}): "1h" | undefined {
  if (ACCOUNT_CHOSE.some((name) => env[name] !== undefined || account.env?.[name] !== undefined)) return undefined;
  if (cliPicksLifetime || paysPerTokenForCache(env, account)) return undefined;
  return "1h";
}
