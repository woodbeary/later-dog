import { accessSync, constants, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelCatalog, ModelVariantOption } from "../contracts.ts";
import { userHome } from "../env-path.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./acp/core.ts";
import { AntigravitySignIn, agySignedIn, agySignedOutError, type AgyLaunch } from "./antigravity-sign-in.ts";

const INSTALL = "curl -fsSL https://antigravity.google/cli/install.sh | bash";

export const ANTIGRAVITY_FALLBACK_MODELS: ModelCatalog = { default: "default", options: [{ id: "default", label: "Default" }] };

type Env = Record<string, string | undefined>;

export function antigravityHome(env: Env, platform: NodeJS.Platform = process.platform): { args: string[]; env: Record<string, string> } {
  if (platform !== "linux") return { args: [], env: {} };
  return {
    args: ["--gemini-dir", join(userHome(env), ".gemini")],
    env: { AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "true", AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
  };
}

const runnable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export function antigravityCli(cli: string | undefined, env: Env): string {
  const name = cli?.trim() || "agy";
  if (isAbsolute(name) || /[\\/]/u.test(name)) return name;
  const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const folder of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = join(folder, name + suffix);
      if (runnable(candidate)) return candidate;
    }
  }
  return join(userHome(env), ".local", "bin", name);
}

export function antigravityMode(approvalMode: ApprovalMode | undefined, offered: readonly string[]): string | null {
  const wanted = approvalMode === "full" ? "auto" : approvalMode === "edits" ? "accept-edits" : "default";
  if (offered.includes(wanted)) return wanted;
  return offered.includes("default") ? "default" : null;
}

type Choice = { value: string; name: string };

function choices(entries: unknown): Choice[] {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry): Choice[] => {
    if (typeof entry?.value === "string") return [{ value: entry.value, name: typeof entry.name === "string" && entry.name ? entry.name : entry.value }];
    return choices(entry?.options);
  });
}

function selectOption(result: unknown, match: (option: any) => boolean): any {
  const options = (result as { configOptions?: unknown } | null)?.configOptions;
  return Array.isArray(options) ? options.find((option) => option?.type === "select" && typeof option.id === "string" && match(option)) : undefined;
}

export function antigravityCatalog(result: unknown, previous: ModelCatalog | null = null): ModelCatalog | null {
  const model = selectOption(result, (option) => option.id === "model");
  const offered = choices(model?.options).filter((choice) => choice.value !== "default");
  if (!offered.length) return null;
  const effort = selectOption(result, (option) => option.category === "thought_level");
  const levels: ModelVariantOption[] = choices(effort?.options).map((choice) => ({ id: choice.value, label: choice.name }));
  const known = new Map((previous?.options ?? []).map((option) => [option.id, option.variants ?? []]));
  return {
    default: "default",
    options: [
      { id: "default", label: "Default" },
      ...offered.map((choice) => {
        const variants = choice.value === model.currentValue ? levels : known.get(choice.value) ?? [];
        return { id: choice.value, label: choice.name, ...(variants.length ? { variants } : {}) };
      }),
    ],
  };
}

const catalogs = new Map<string, ModelCatalog>();
const catalogFile = (instanceId: string) => join(DATA_DIR, "providers", "antigravity-models", `${instanceId}.json`);

function savedCatalog(instanceId: string): ModelCatalog | null {
  const held = catalogs.get(instanceId);
  if (held) return held;
  try {
    const saved = JSON.parse(readFileSync(catalogFile(instanceId), "utf8")) as ModelCatalog;
    if (typeof saved?.default !== "string" || !Array.isArray(saved.options) || !saved.options.length) return null;
    catalogs.set(instanceId, saved);
    return saved;
  } catch {
    return null;
  }
}

function keepCatalog(instanceId: string, catalog: ModelCatalog): void {
  catalogs.set(instanceId, catalog);
  try {
    const file = catalogFile(instanceId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(catalog));
    renameSync(`${file}.tmp`, file);
  } catch {}
}

const LEFT_BEHIND = /^(GEMINI_HOME|BROWSER|ANTIGRAVITY_HARNESS_PATH|AGY_ACP_.*|AGY_LLM_GATEWAY_.*)$/u;

function launchFor(env: Env, config: AcpConfig): AgyLaunch {
  return { command: antigravityCli(config.cli, env), args: ["acp", ...antigravityHome(env).args], env };
}

function modeChoices(result: unknown): { id: string; values: string[]; currentValue?: string } | null {
  const option = selectOption(result, (entry) => entry.category === "mode" || entry.id === "mode");
  if (!option) return null;
  return { id: option.id, values: choices(option.options).map((choice) => choice.value), currentValue: option.currentValue };
}

function listedModes(modes: unknown): string[] {
  const available = (modes as { availableModes?: unknown } | null)?.availableModes;
  return Array.isArray(available) ? available.flatMap((mode) => (typeof mode?.id === "string" ? [mode.id] : [])) : [];
}

const NO_MODE = "Antigravity offered no approval mode later.dog can use.";

const support: AcpSupport = {
  driverKind: "antigravityAgent",
  displayName: "Antigravity",
  models: ANTIGRAVITY_FALLBACK_MODELS,
  modelVariants: true,
  defaultCli: "agy",
  nativeSource: "antigravity.acp",
  loginNote: "Antigravity is not signed in. Sign in with Google in engine setup.",
  install: { command: { darwin: INSTALL, linux: INSTALL }, docsUrl: "https://antigravity.google/docs" },
  images: true,
  terminalAuth: true,
  additionalDirectories: true,
  selectModel: { configId: "model" },
  sessionScopedApproval: true,
  resumeMethod: "resume",
  redactStderr: true,
  sanitizeToolPayload: true,
  spawnArgs: (_config, turn) => Object.values(turn.integrations?.custom ?? {}).some((server) => "url" in server && server.type === "http")
    ? ["--process-per-session"]
    : [],
  transformEnv: (env) => {
    for (const key of Object.keys(env)) if (LEFT_BEHIND.test(key)) delete env[key];
    Object.assign(env, antigravityHome(env).env);
  },
  resolveCommand: async (env, config) => {
    const { command, args } = launchFor(env, config);
    return { command, args };
  },
  resolveModels: (_env, _config, instanceId) => savedCatalog(instanceId) ?? ANTIGRAVITY_FALLBACK_MODELS,
  observeSessionConfig: (result, instanceId) => {
    const previous = savedCatalog(instanceId);
    const next = antigravityCatalog(result, previous);
    if (next && JSON.stringify(next) !== JSON.stringify(previous)) keepCatalog(instanceId, next);
    return next;
  },
  resolveTurnModel: (model) => (model === "default" ? "" : model),
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: async (env, config) => {
    try {
      return await agySignedIn(launchFor(env, config));
    } catch {
      return false;
    }
  },
  classifyError: (error) => (agySignedOutError(error) ? "invalid_credentials" : undefined),
  pasteSignIn: ({ environment, config, changed }) => new AntigravitySignIn({
    launch: async () => launchFor(environment(), config),
    onChange: changed,
  }),
  configureSession: async ({ request, sessionId, turn, sessionConfig, sessionModes }) => {
    const option = modeChoices(sessionConfig);
    if (option) {
      const mode = antigravityMode(turn.approvalMode, option.values);
      if (!mode) throw new Error(NO_MODE);
      const result = await request("session/set_config_option", { sessionId, configId: option.id, value: mode });
      const applied = modeChoices(result)?.currentValue;
      if (applied !== undefined && applied !== mode) throw new Error(`Antigravity did not switch to ${mode}.`);
      return;
    }
    const listed = listedModes(sessionModes);
    if (!listed.length) return;
    const mode = antigravityMode(turn.approvalMode, listed);
    if (!mode) throw new Error(NO_MODE);
    await request("session/set_mode", { sessionId, modeId: mode });
  },
};

export const AntigravityDriver = createAcpDriver(support);
