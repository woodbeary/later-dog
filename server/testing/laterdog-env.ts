
const AMBIENT_PREFIXES = ["LATERDOG_"] as const;

export function isAmbientLaterDogKey(key: string): boolean {
  return AMBIENT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function stripLaterDogEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isAmbientLaterDogKey(key)) clean[key] = value;
  }
  return clean;
}

export function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...stripLaterDogEnv(process.env), ...overrides };
}
