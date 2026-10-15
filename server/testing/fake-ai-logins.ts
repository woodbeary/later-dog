export const fixtureClaudeLogin = (n = 1) => ({
  accessToken: `fixture-claude-access-${n}`,
  refreshToken: `fixture-claude-refresh-${n}`,
  expiresAt: 1_900_000_000_000,
  scopes: ["user:inference", "user:profile"],
  subscriptionType: "max",
  rateLimitTier: "fixture-tier",
  clientId: "fixture-client",
});

export const fixtureCodexLogin = (n = 1) => ({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  last_refresh: "2026-10-14T00:00:00Z",
  tokens: {
    id_token: `fixture-codex-id-${n}`,
    access_token: `fixture-codex-access-${n}`,
    refresh_token: `fixture-codex-refresh-${n}`,
    account_id: "fixture-account",
  },
});
