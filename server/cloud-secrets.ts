import { closeSync, readFileSync } from "node:fs";

export const CLOUD_HOME_SECRET_KEYS = ["LATERDOG_CLOUD_BOOTSTRAP_SECRET", "LATERDOG_CLOUD_BOAT_TOKEN", "LATERDOG_CLOUD_VOICE_TOKEN", "LATERDOG_CLOUD_DECIDER_TOKEN"] as const;
export const CLOUD_SECRETS_FD_ENV = "LATERDOG_CLOUD_SECRETS_FD";

export function cloudHomeSecrets(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(CLOUD_HOME_SECRET_KEYS.flatMap((key) => env[key] ? [[key, env[key]!]] : []));
}

export function withoutCloudSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = { ...env };
  for (const key of CLOUD_HOME_SECRET_KEYS) delete kept[key];
  return kept;
}

function invalid(why: string): never {
  throw new Error(`Cloud home configuration is invalid: ${why}.`);
}

export function takeCloudSecrets(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const named = env[CLOUD_SECRETS_FD_ENV];
  if (named === undefined) return {};
  delete env[CLOUD_SECRETS_FD_ENV];
  const fd = Number(named);
  if (!Number.isInteger(fd) || fd < 3 || fd > 1024) invalid(`${CLOUD_SECRETS_FD_ENV} must name an inherited descriptor`);
  let raw: string;
  try {
    raw = readFileSync(fd, "utf8");
  } catch {
    invalid("the Cloud home's secrets could not be read from the launcher");
  } finally {
    try { closeSync(fd); } catch {}
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw!); } catch { parsed = null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid("the Cloud home's secrets from the launcher are not readable");
  const record = parsed as Record<string, unknown>;
  return Object.fromEntries(CLOUD_HOME_SECRET_KEYS.flatMap((key) => typeof record[key] === "string" && record[key] ? [[key, record[key] as string]] : []));
}
