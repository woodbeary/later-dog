const CLAUDE_ACCOUNT_TOKEN = /^CLAUDE_CODE_OAUTH_TOKEN_[A-Z0-9_]+$/;
const PASSED = ["GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "LATERDOG_WORKSPACE_URL", "ANTHROPIC_API_KEY", "LATERDOG_SCREEN_CHECKS"] as const;

export function supervisorEnv(env: Record<string, unknown>, stateUrl: string): Record<string, string> {
  const envVars: Record<string, string> = {
    LATERDOG_TOKEN: String(env.LATERDOG_TOKEN ?? ""),
    LATERDOG_BACKUP_KEY: String(env.LATERDOG_BACKUP_KEY ?? ""),
    LATERDOG_STATE_URL: stateUrl,
  };
  for (const name of PASSED) {
    const value = env[name];
    if (typeof value === "string" && value) envVars[name] = value;
  }
  if (typeof env.TRACE_RETENTION_DAYS === "string" && env.TRACE_RETENTION_DAYS) envVars.LATERDOG_TRACE_RETENTION_DAYS = env.TRACE_RETENTION_DAYS;
  for (const [name, value] of Object.entries(env)) {
    if (CLAUDE_ACCOUNT_TOKEN.test(name) && typeof value === "string") envVars[name] = value;
  }
  return envVars;
}
