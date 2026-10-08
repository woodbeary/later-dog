// Keeping a test's children honest about later.dog configuration.
//
// A shell that already exports LATERDOG_* — a later.dog-hosted
// terminal, or a server running in another window — leaks those values into
// every child a suite spawns and into modules that snapshot process.env at
// import time. The suite then asserts against a "configured" runtime the test
// itself never set up (#1676). Strip the ambient values here; each test sets
// exactly the keys it means to set, on top of a base that carries no
// later.dog configuration at all.

const AMBIENT_PREFIXES = ["LATERDOG_"] as const;

/** True for keys owned by the later.dog runtime (`LATERDOG_*`). */
export function isAmbientLaterDogKey(key: string): boolean {
  return AMBIENT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Copy `env` without any `LATERDOG_*` keys. */
export function stripLaterDogEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isAmbientLaterDogKey(key)) clean[key] = value;
  }
  return clean;
}

/**
 * Environment for a child process spawned by a test: the current environment
 * with ambient later.dog keys stripped, then `overrides` applied on top.
 *
 * The spread sits where `...process.env` used to, so a suite's own keys —
 * harness URL, tokens the stub validates, feature flags under test — are the
 * only later.dog configuration the child ever sees.
 */
export function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...stripLaterDogEnv(process.env), ...overrides };
}
