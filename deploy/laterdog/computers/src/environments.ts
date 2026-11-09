import { sha256Hex } from "./auth";
import { MINUTE } from "./idle";
import type { Parsed } from "./inputs";
import { DAY } from "./trial";

export const ENVIRONMENT_FORMAT = 1;
export const SETUP_BUDGET_MS = 5 * MINUTE;
export const REBUILD_AFTER_MS = 7 * DAY;
export const SNAPSHOT_TTL_MS = 30 * DAY;
export const TTL_MARGIN_MS = 3 * DAY;
export const BUILD_STUCK_MS = 20 * MINUTE;
export const RETRY_FAILED_MS = 60 * MINUTE;
export const MAINTENANCE_TIMEOUT_MS = 2 * MINUTE;
export const SETUP_SCRIPT_MAX_CHARS = 16 * 1024;
export const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
export const REPOSITORIES_HOME = "/home/dog/repos";

export type Outcome = "ready" | "uncached" | "failed";

export interface EnvironmentSnapshot {
  id: string;
  size: number;
  name?: string;
}

export interface EnvironmentRow {
  key: string;
  repository: string;
  scriptHash: string;
  image: string;
  snapshot?: EnvironmentSnapshot;
  builtAt?: number;
  restoredAt?: number;
  setupMs?: number;
  buildingSince?: number;
  outcome?: Outcome;
  attemptAt?: number;
  error?: string;
}

export type EnvironmentState = "none" | "building" | "fresh" | "stale" | "expiring" | "uncached" | "failed";

export interface EnvironmentDecision {
  use: boolean;
  build: boolean;
  state: EnvironmentState;
}

export interface EnvironmentView {
  key: string;
  repository: string;
  state: EnvironmentState;
  building: boolean;
  custom: boolean;
  builtAt?: string;
  rebuildAt?: string;
  expiresAt?: string;
  setupMs?: number;
  lastOutcome?: Outcome;
  error?: string;
}

export interface EnvironmentPlan {
  key: string;
  repository: string;
  image: string;
  decision: EnvironmentDecision;
  snapshot?: EnvironmentSnapshot;
  script?: string;
  view: EnvironmentView;
}

export interface BuildReport {
  key: string;
  outcome: Outcome;
  setupMs: number;
  snapshot?: EnvironmentSnapshot;
  error?: string;
}

export const repositoryDir = (repository: string) => `${REPOSITORIES_HOME}/${repository}`;

export async function scriptHash(script: string): Promise<string> {
  return (await sha256Hex(script)).slice(0, 32);
}

export async function environmentKey(repository: string, script: string, image: string): Promise<string> {
  const digest = await sha256Hex(`${ENVIRONMENT_FORMAT}\0${repository}\0${await scriptHash(script)}\0${image}`);
  return `env_${digest.slice(0, 32)}`;
}

export async function setupRunKey(repository: string): Promise<string> {
  return (await sha256Hex(`environment\0${repository}`)).slice(0, 16);
}

export const builderName = (registry: string, key: string) => `environment:${registry}:${key}`;
export const plannerName = (registry: string) => `environments:${registry}`;

export function expiresAt(row: EnvironmentRow): number | undefined {
  if (!row.snapshot || row.builtAt === undefined) return undefined;
  return Math.max(row.builtAt, row.restoredAt ?? 0) + SNAPSHOT_TTL_MS;
}

function backoff(row: EnvironmentRow): number {
  if (row.attemptAt === undefined || (row.builtAt !== undefined && row.attemptAt <= row.builtAt)) return 0;
  if (row.outcome === "failed") return RETRY_FAILED_MS;
  if (row.outcome === "uncached") return REBUILD_AFTER_MS;
  return 0;
}

export function decideEnvironment(row: EnvironmentRow | undefined, now: number): EnvironmentDecision {
  if (!row) return { use: false, build: true, state: "none" };
  const building = row.buildingSince !== undefined && now - row.buildingSince < BUILD_STUCK_MS;
  const expiry = expiresAt(row);
  const usable = expiry !== undefined && now < expiry - TTL_MARGIN_MS;
  const old = row.builtAt !== undefined && now - row.builtAt >= REBUILD_AFTER_MS;
  const wanted = !usable || old;
  const waited = backoff(row);
  const build = wanted && !building && (waited === 0 || now - row.attemptAt! >= waited);
  let state: EnvironmentState;
  if (usable) state = old ? "stale" : "fresh";
  else if (building) state = "building";
  else if (row.snapshot) state = "expiring";
  else state = row.outcome === "uncached" ? "uncached" : row.outcome === "failed" ? "failed" : "none";
  return { use: usable, build, state };
}

export function environmentView(row: EnvironmentRow | undefined, base: { key: string; repository: string; custom: boolean }, now: number): EnvironmentView {
  const decision = decideEnvironment(row, now);
  const iso = (ms: number) => new Date(ms).toISOString();
  const expiry = row ? expiresAt(row) : undefined;
  return {
    key: base.key,
    repository: base.repository,
    state: decision.state,
    building: row?.buildingSince !== undefined && now - row.buildingSince < BUILD_STUCK_MS,
    custom: base.custom,
    ...(row?.builtAt === undefined ? {} : { builtAt: iso(row.builtAt), rebuildAt: iso(row.builtAt + REBUILD_AFTER_MS) }),
    ...(expiry === undefined ? {} : { expiresAt: iso(expiry) }),
    ...(row?.setupMs === undefined ? {} : { setupMs: row.setupMs }),
    ...(row?.outcome === undefined ? {} : { lastOutcome: row.outcome }),
    ...(row?.error ? { error: row.error } : {}),
  };
}

export function parseRepository(raw: unknown): Parsed<string> {
  if (typeof raw !== "string" || !REPOSITORY.test(raw.trim()) || raw.includes("..")) {
    return { ok: false, refusal: { status: 400, code: "invalid_repository", message: "repository must be owner/name, as on GitHub." } };
  }
  return { ok: true, value: raw.trim() };
}

export function repositoryField(body: unknown): Parsed<string | undefined> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: true, value: undefined };
  const raw = (body as Record<string, unknown>).repository;
  return raw === undefined || raw === null ? { ok: true, value: undefined } : parseRepository(raw);
}

export function parseEnvironmentRequest(body: unknown): Parsed<{ repository: string; setupScript?: string | null }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, refusal: { status: 400, code: "invalid_body", message: 'The body must be a JSON object with a "repository".' } };
  }
  const record = body as Record<string, unknown>;
  const repository = parseRepository(record.repository);
  if (!repository.ok) return repository;
  const script = record.setupScript;
  if (script === undefined) return { ok: true, value: { repository: repository.value } };
  if (script === null) return { ok: true, value: { repository: repository.value, setupScript: null } };
  if (typeof script !== "string" || script.trim().length === 0 || script.length > SETUP_SCRIPT_MAX_CHARS || script.includes("\u0000")) {
    return { ok: false, refusal: { status: 400, code: "invalid_setup_script", message: `setupScript must be 1 to ${SETUP_SCRIPT_MAX_CHARS} characters without NUL, or null for the default.` } };
  }
  return { ok: true, value: { repository: repository.value, setupScript: script } };
}

const LOCKFILE_NAMES = "pnpm-lock.yaml package-lock.json yarn.lock bun.lock bun.lockb npm-shrinkwrap.json";

export const ENVIRONMENT_PRELUDE = `export PATH="$HOME/.local/bin:$PATH"
laterdog_sha256() { if command -v sha256sum > /dev/null 2>&1; then sha256sum; else shasum -a 256; fi; }
laterdog_lock_key() {
  found=0
  for name in ${LOCKFILE_NAMES}; do
    if [ -f "$name" ] && [ ! -L "$name" ]; then found=1; fi
  done
  [ "$found" = 1 ] || return 0
  {
    for name in ${LOCKFILE_NAMES}; do
      if [ -f "$name" ] && [ ! -L "$name" ]; then printf '%s\\0%s\\0' "$name" "$(wc -c < "$name" | tr -d ' ')"; cat "$name"; fi
    done
  } | laterdog_sha256 | cut -c1-24
}
laterdog_tool() { command -v "$1" > /dev/null 2>&1 || npm install -g --prefix "$HOME/.local" "$1" > /dev/null 2>&1; }
laterdog_install() {
  if [ -f pnpm-lock.yaml ]; then laterdog_tool pnpm && pnpm install --frozen-lockfile --prefer-offline
  elif [ -f bun.lock ] || [ -f bun.lockb ]; then laterdog_tool bun && bun install --frozen-lockfile
  elif [ -f yarn.lock ]; then laterdog_tool yarn && yarn install --frozen-lockfile --prefer-offline
  elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci --prefer-offline --no-audit --no-fund
  elif [ -f package.json ]; then npm install --prefer-offline --no-audit --no-fund
  fi
}
laterdog_register() {
  lock=$(laterdog_lock_key)
  [ -n "$lock" ] || return 0
  if [ -d .git ]; then printf '%s\\n' "$lock" > .git/laterdog-installed-lock; fi
  [ -d node_modules ] || return 0
  mkdir -p "$HOME/runs/.setup"
  ln -sfn "$LATERDOG_REPOSITORY_DIR" "$HOME/runs/$LATERDOG_RUN_KEY"
  printf '%s\\n' "$LATERDOG_RUN_KEY" > "$HOME/runs/.setup/$lock.environment" && mv -f "$HOME/runs/.setup/$lock.environment" "$HOME/runs/.setup/$lock"
}
`;

export const DEFAULT_SETUP_SCRIPT = `set -e
mkdir -p "$(dirname "$LATERDOG_REPOSITORY_DIR")"
[ -d "$LATERDOG_REPOSITORY_DIR/.git" ] || GIT_TERMINAL_PROMPT=0 git clone --quiet "https://github.com/$LATERDOG_REPOSITORY.git" "$LATERDOG_REPOSITORY_DIR"
cd "$LATERDOG_REPOSITORY_DIR"
laterdog_install
`;

export const setupCommand = (script: string) => `${ENVIRONMENT_PRELUDE}\ncd "$HOME"\n${script}\n`;

export const REGISTER_SCRIPT = `${ENVIRONMENT_PRELUDE}
[ -d "$LATERDOG_REPOSITORY_DIR" ] || exit 0
cd "$LATERDOG_REPOSITORY_DIR" && laterdog_register
`;

export const MAINTENANCE_SCRIPT = `${ENVIRONMENT_PRELUDE}
fetched=0
installed=0
if [ -d "$LATERDOG_REPOSITORY_DIR/.git" ]; then
  cd "$LATERDOG_REPOSITORY_DIR"
  limit=""
  if command -v timeout > /dev/null 2>&1; then limit="timeout 60"; fi
  if GIT_TERMINAL_PROMPT=0 $limit git fetch --quiet --prune origin > /dev/null 2>&1; then
    fetched=1
    if [ -z "$(git status --porcelain --untracked-files=no)" ] && git rev-parse -q --verify '@{u}' > /dev/null 2>&1; then git merge --ff-only --quiet '@{u}' > /dev/null 2>&1 || true; fi
  fi
  now=$(laterdog_lock_key)
  before=$(cat .git/laterdog-installed-lock 2>/dev/null || true)
  if [ -n "$now" ] && [ "$now" != "$before" ]; then
    if laterdog_install > "$HOME/.laterdog-maintenance.log" 2>&1; then installed=1; laterdog_register; else installed=failed; fi
  fi
else
  fetched=none
fi
echo "laterdog-maintenance fetched=$fetched installed=$installed"
`;

export type Maintenance = { fetched: "yes" | "no" | "no_checkout"; installed: "yes" | "no" | "failed" };

export function maintenanceFrom(stdout: string): Maintenance | undefined {
  const match = /laterdog-maintenance fetched=(\w+) installed=(\w+)/.exec(stdout);
  if (!match) return undefined;
  const fetched = match[1] === "1" ? "yes" : match[1] === "none" ? "no_checkout" : "no";
  const installed = match[2] === "1" ? "yes" : match[2] === "failed" ? "failed" : "no";
  return { fetched, installed };
}

export function environmentEnv(repository: string, runKey: string): Record<string, string> {
  return { LATERDOG_REPOSITORY: repository, LATERDOG_REPOSITORY_DIR: repositoryDir(repository), LATERDOG_RUN_KEY: runKey };
}
