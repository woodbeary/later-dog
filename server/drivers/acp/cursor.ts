import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { titleCaseModelId } from "../../contracts.ts";
import { execCli } from "../../procs.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

export function resolveCursorAcpModelId(
  available: Array<{ modelId?: string; name?: string }>,
  wanted: string,
): string | null {
  const want = wanted.trim().toLowerCase();
  if (!want) return null;
  const ids = available.filter((m) => typeof m?.modelId === "string" && m.modelId);
  if (!ids.length) return null;
  const base = (id: string) => id.split("[")[0].trim().toLowerCase();

  const exact = ids.find((m) => m.modelId!.toLowerCase() === want);
  if (exact) return exact.modelId!;

  const isFast = (id: string) => /[[,]\s*fast\s*=\s*true\s*[\],]/i.test(id);
  const sameBase = ids.filter((m) => base(m.modelId!) === want);
  const byBase = sameBase.find((m) => !isFast(m.modelId!)) ?? sameBase[0];
  if (byBase) return byBase.modelId!;

  if (want.endsWith("-fast")) {
    const stem = want.slice(0, -"-fast".length);
    const fast = ids.find((m) => base(m.modelId!) === stem && isFast(m.modelId!));
    if (fast) return fast.modelId!;
  }

  const byName = ids.find((m) => (m.name ?? "").trim().toLowerCase() === want);
  if (byName) return byName.modelId!;

  if (want === "auto" || want === "default") {
    const dflt = ids.find((m) => base(m.modelId!) === "default");
    if (dflt) return dflt.modelId!;
  }
  return null;
}

export const STATIC_CURSOR_MODELS: ModelCatalog = {
  default: "auto",
  options: [
    { id: "auto", label: "Auto" },
    { id: "composer-2.5", label: "Composer 2.5" },
    { id: "composer-2.5-fast", label: "Composer 2.5 Fast" },
    { id: "gpt-5.3-codex", label: "Codex 5.3" },
    { id: "claude-sonnet-5-thinking-high", label: "Claude Sonnet 5 1M Thinking" },
  ],
};

const SLUG = /^[a-z0-9][a-z0-9._:+-]*$/i;
const EXEC_TIMEOUT_MS = 8_000;

const nonBlank = (value: string | undefined): boolean => Boolean(value?.trim());

function firstJsonValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  const start = trimmed.search(/[{[]/);
  if (start < 0) return null;
  for (let end = trimmed.length; end > start + 1; end--) {
    const slice = trimmed.slice(start, end).trim();
    if (!slice.endsWith("}") && !slice.endsWith("]")) continue;
    try {
      return JSON.parse(slice);
    } catch {}
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function labelFor(id: string, explicit?: string): string {
  const trimmed = explicit?.trim();
  return trimmed || titleCaseModelId(id, /[-_./]+/);
}

function pushModel(
  options: ModelCatalog["options"],
  seen: Set<string>,
  id: string,
  label?: string,
  custom = false,
): void {
  if (!SLUG.test(id) || seen.has(id)) return;
  seen.add(id);
  options.push({ id, label: labelFor(id, label), ...(custom ? { custom: true as const } : {}) });
}

export function decodeCursorModelCatalog(payload: unknown): ModelCatalog | null {
  const records: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray(asRecord(payload)?.models)
      ? (asRecord(payload)!.models as unknown[])
      : Array.isArray(asRecord(payload)?.data)
        ? (asRecord(payload)!.data as unknown[])
        : Array.isArray(asRecord(payload)?.modelIds)
          ? (asRecord(payload)!.modelIds as unknown[])
          : [];
  if (!records.length) return null;

  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  for (const row of records) {
    if (typeof row === "string") {
      pushModel(options, seen, row);
      continue;
    }
    const rec = asRecord(row);
    if (!rec) continue;
    const id = rec.id ?? rec.modelId ?? rec.slug ?? rec.name;
    if (typeof id !== "string") continue;
    const label =
      (typeof rec.label === "string" && rec.label) ||
      (typeof rec.displayName === "string" && rec.displayName) ||
      (typeof rec.name === "string" && rec.name !== id ? rec.name : undefined);
    pushModel(options, seen, id, label || undefined);
  }
  if (!options.length) return null;

  const defaultId =
    (typeof asRecord(payload)?.default === "string" && seen.has(asRecord(payload)!.default as string)
      ? (asRecord(payload)!.default as string)
      : undefined) ??
    (seen.has(STATIC_CURSOR_MODELS.default) ? STATIC_CURSOR_MODELS.default : options[0]!.id);

  const merged: ModelCatalog["options"] = STATIC_CURSOR_MODELS.options.map((option) => ({ ...option }));
  const mergedSeen = new Set(merged.map((option) => option.id));
  for (const option of options) {
    if (mergedSeen.has(option.id)) continue;
    mergedSeen.add(option.id);
    merged.push(option);
  }
  return { default: defaultId, options: merged };
}

function stripModelMarkers(label: string): { label: string; isDefault: boolean; isCurrent: boolean } {
  let cleaned = label.trim();
  let isDefault = false;
  let isCurrent = false;
  const defaultMatch = cleaned.match(/\s*\(default\)\s*$/i);
  if (defaultMatch) {
    isDefault = true;
    cleaned = cleaned.slice(0, defaultMatch.index).trim();
  }
  const currentMatch = cleaned.match(/\s*\(current\)\s*$/i);
  if (currentMatch) {
    isCurrent = true;
    cleaned = cleaned.slice(0, currentMatch.index).trim();
  }
  return { label: cleaned, isDefault, isCurrent };
}

export function decodeCursorModelText(text: string): ModelCatalog | null {
  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  let markedDefault: string | undefined;
  let markedCurrent: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || /^available\s+models?\b/i.test(line) || /^models?\b/i.test(line)) continue;
    const stripped = line.replace(/^[\s*•-]+\s*/, "");
    const parts = stripped.split(/\s+[—–|:]\s+|\s+-\s+|\s{2,}/);
    const id = (parts[0] ?? "").trim();
    const rawLabel = parts.slice(1).join(" ").trim();
    const { label, isDefault, isCurrent } = stripModelMarkers(rawLabel);
    pushModel(options, seen, id, label || undefined);
    if (isDefault) markedDefault = id;
    if (isCurrent) markedCurrent = id;
  }
  if (!options.length) return null;
  const merged: ModelCatalog["options"] = STATIC_CURSOR_MODELS.options.map((option) => ({ ...option }));
  const mergedSeen = new Set(merged.map((option) => option.id));
  for (const option of options) {
    if (mergedSeen.has(option.id)) continue;
    mergedSeen.add(option.id);
    merged.push(option);
  }
  const defaultId =
    (markedDefault && seen.has(markedDefault) ? markedDefault : undefined) ??
    (markedCurrent && seen.has(markedCurrent) ? markedCurrent : undefined) ??
    (seen.has(STATIC_CURSOR_MODELS.default) ? STATIC_CURSOR_MODELS.default : options[0]!.id);
  return { default: defaultId, options: merged };
}

function truthyAuthFlag(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "authenticated", "logged_in", "logged-in", "yes"].includes(normalized)) return true;
    if (["false", "unauthenticated", "logged_out", "logged-out", "no"].includes(normalized)) return false;
  }
  return null;
}

export function decodeCursorAuthStatus(payload: unknown): boolean | null {
  const rec = asRecord(payload);
  if (!rec) return null;
  const auth = asRecord(rec.auth);
  const candidates = [
    rec.isAuthenticated,
    rec.authenticated,
    rec.loggedIn,
    rec.logged_in,
    auth?.isAuthenticated,
    auth?.authenticated,
    rec.status,
    auth?.status,
  ];
  for (const candidate of candidates) {
    const flag = truthyAuthFlag(candidate);
    if (flag !== null) return flag;
  }
  return null;
}

export function decodeCursorAuthText(text: string): boolean | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;
  if (/not (?:logged|signed) in|not authenticated|unauthenticated|logged out/.test(normalized)) return false;
  if (/login successful|logged in|signed in|authenticated/.test(normalized)) return true;
  return null;
}

function execText(
  run: typeof execCli,
  cli: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<string | null> {
  return new Promise((resolve) => {
    run(cli, args, { timeout: EXEC_TIMEOUT_MS, env: env as NodeJS.ProcessEnv }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout ?? ""));
    });
  });
}

export async function probeCursorAuth(
  cli: string,
  env: Record<string, string | undefined>,
  run: typeof execCli = execCli,
): Promise<boolean> {
  if (nonBlank(env.CURSOR_API_KEY) || nonBlank(env.CURSOR_AUTH_TOKEN)) return true;
  for (const args of [["status", "--format", "json"], ["status"]] as const) {
    const stdout = await execText(run, cli, [...args], env);
    if (stdout == null) continue;
    const decoded = decodeCursorAuthStatus(firstJsonValue(stdout)) ?? decodeCursorAuthText(stdout);
    if (decoded !== null) return decoded;
  }
  return false;
}

export async function fetchCursorModels(
  cli: string,
  env: Record<string, string | undefined>,
  run: typeof execCli = execCli,
): Promise<ModelCatalog> {
  for (const args of [["models"], ["--list-models"]] as const) {
    const stdout = await execText(run, cli, [...args], env);
    if (stdout == null) continue;
    const fromText = decodeCursorModelText(stdout);
    if (fromText) return fromText;
    const fromJson = decodeCursorModelCatalog(firstJsonValue(stdout));
    if (fromJson) return fromJson;
  }
  return STATIC_CURSOR_MODELS;
}

export function classifyCursorError(error: unknown): ProviderErrorCode | undefined {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const blob = `${code ?? ""} ${message}`.toLowerCase();
  if (
    code === -32000 ||
    /unauthoriz|unauthenticated|not signed in|not logged in|invalid api key|invalid_credentials|authentication required/.test(
      blob,
    )
  ) {
    return "invalid_credentials";
  }
  if (/inactive subscription|subscription.*(expired|inactive)|upgrade your (plan|subscription)/.test(blob)) {
    return "inactive_subscription";
  }
  return undefined;
}

const support = (run: typeof execCli): AcpSupport => ({
  driverKind: "cursorAgent",
  displayName: "Cursor",
  models: STATIC_CURSOR_MODELS,
  defaultCli: "cursor-agent",
  nativeSource: "cursor.acp",
  loginNote: "Cursor CLI is not signed in — run `cursor-agent login` in a terminal, or set CURSOR_API_KEY",

  install: {
    command: {
      darwin: "curl https://cursor.com/install -fsS | bash",
      linux: "curl https://cursor.com/install -fsS | bash",
      win32: "irm 'https://cursor.com/install?win32=true' | iex",
    },
    docsUrl: "https://cursor.com/docs/cli/installation",
    signInCommand: "cursor-agent login",
  },

  spawnArgs: (config, turn) => [
    ...(config.fullAuto ? ["--force"] : turn.approvalMode === "auto" ? ["--auto-review"] : []),
    ...(turn.model ? ["--model", turn.model] : []),
    "acp",
  ],
  credentialEnv: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"],

  resolveModels: (environment, config) => fetchCursorModels(config.cli || "cursor-agent", environment, run),

  pickAuthMethod: (methods) => (methods.some((m) => m.id === "cursor_login") ? "cursor_login" : null),
  authFailure: "continue",
  isAuthenticated: (env, config) => probeCursorAuth(config.cli || "cursor-agent", env, run),
  classifyError: classifyCursorError,

  async configureSession({ request, sessionId, turn, sessionModels }) {
    if (!turn.model) return;
    const modelId = resolveCursorAcpModelId(sessionModels ?? [], turn.model) ?? turn.model;
    try {
      await request("session/set_model", { sessionId, modelId });
    } catch (e) {
      const err = e as Error & { code?: unknown };
      if (err.code === -32601 || err.code === -32602) return;
      throw new Error(
        `Cursor rejected model "${turn.model}" (sent as "${modelId}") via session/set_model: ${err.message}. ` +
          `Check that \`cursor-agent\` is current and that this account can use that model.`,
      );
    }
  },

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
});

export function createCursorAgentDriver(run: typeof execCli = execCli) {
  return createAcpDriver(support(run));
}

export const CursorAgentDriver = createCursorAgentDriver();
