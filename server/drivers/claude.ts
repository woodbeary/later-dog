import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, dirname, isAbsolute, normalize } from "node:path";

import { DATA_DIR, stripWorkspaceCredentialEnv } from "../config.ts";
import { writeFileAtomic, writeFileAtomicIfChanged } from "../atomic.ts";
import { augmentedPath } from "../env-path.ts";
import { brokerSocketPath, describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import { classifyResumeFailure, mayReplay, recoveryPromptFor } from "../resume-recovery.ts";
import { ClaudeLoginController } from "./claude-login-auth.ts";

import type {
  DriverCreateInput,
  EffortLevel,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  SteerOutcome,
  TextGenerationOptions,
} from "../contracts.ts";
import { gateServer, resultBudget } from "../mcp-gate-config.ts";
import { canUseMcpServer } from "../../shared/tool-scope.ts";
import { assertToolScopeSupported } from "../../shared/tool-scope-support.ts";
import { newEventId, newId } from "../contracts.ts";
import { askInputSummary, commandSummary, toolDetailPreview } from "../tool-summary.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./retry.ts";
import { ClaudeTasks } from "./claude-tasks.ts";
import { sessionIdlePolicy } from "./session-idle.ts";
import { parseVersionTriple, versionAtLeast } from "./acp/core.ts";
import {
  applyClaudeInject,
  decodeInjectId,
  mergeLocalInject,
  probeLocalInjects,
  resolveInjectId,
} from "./local-inject.ts";
import { appendNative } from "./native.ts";
import { claudeUsageLimit, rejectedRateLimit, type UsageLimit } from "../laterdog/usage-limit.ts";
import { permissionCommand, permissionLaunchCwd } from "./permission-command.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { laterdogPreallowedTools } from "../laterdog/own-tools.ts";
import { claudeEffortArg, claudeEffortLevels } from "../laterdog/effort-levels.ts";
import { machineClaudeMemoryExcludes } from "../laterdog/claude-memory-isolation.ts";
import { quietWorkEnvironment } from "../laterdog/work-updates.ts";
import { extractMcpImages } from "../mcp-tool-images.ts";
import {
  ASK_USER_QUESTION_TOOL,
  askQuestionSummary,
  parseAskQuestions,
  parseChoices,
  questionChoices,
  type AskQuestion,
} from "../../shared/ask-question.ts";

function claudeAuthStatus(
  cli: string,
  env: NodeJS.ProcessEnv,
  run: typeof execCli = execCli,
): Promise<{ authenticated: boolean; account?: ProviderSnapshot["account"] }> {
  return new Promise((resolve) => {
    run(cli, ["auth", "status", "--json"], { timeout: 8000, maxBuffer: 65_536, env }, (_error, stdout) => {
      try {
        const status: unknown = JSON.parse(stdout);
        if (!status || typeof status !== "object" || !("loggedIn" in status) || status.loggedIn !== true) {
          return resolve({ authenticated: false });
        }
        const identity = status as { email?: unknown; orgName?: unknown; authMethod?: unknown };
        const boundedText = (value: unknown, max: number): string | undefined =>
          typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value)
            ? value.trim() : undefined;
        const candidateEmail = boundedText(identity.email, 254);
        const email = candidateEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateEmail) ? candidateEmail : undefined;
        const organization = boundedText(identity.orgName, 160);
        const account = {
          ...(email ? { email } : {}),
          ...(organization ? { organization } : {}),
          ...(identity.authMethod === "api_key" ? { method: "api-key" as const } : {}),
        };
        resolve({ authenticated: true, ...(Object.keys(account).length ? { account } : {}) });
      } catch {
        resolve({ authenticated: false });
      }
    });
  });
}

export async function claudeSignedIn(
  cli: string,
  env: NodeJS.ProcessEnv,
  run: typeof execCli = execCli,
): Promise<boolean> {
  return (await claudeAuthStatus(cli, env, run)).authenticated;
}

export const CLAUDE_ACCOUNT_ENV_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

export function resolveClaudeConfigDir(configDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  const configured = configDir?.trim() || env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const expanded = configured === "~" ? home : configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
  if (!isAbsolute(expanded) || /[\p{Cc}\p{Cf}]/u.test(expanded)) {
    throw new Error("claude: configDir must be an absolute path or start with ~/");
  }
  return normalize(expanded);
}

export function claudeAuthFailure(
  frame: { error?: unknown; is_api_error_message?: unknown },
  text: string,
): boolean {
  if (frame.is_api_error_message !== true && typeof frame.error !== "string") return false;
  return frame.error === "authentication_failed" || classifyError({ text }).reason === "auth";
}

export function claudeVersionTooOld(
  frame: { error?: unknown; is_api_error_message?: unknown },
  text: string,
): boolean {
  if (frame.is_api_error_message !== true && typeof frame.error !== "string") return false;
  return /\bClaude Code v?\d+(?:\.\d+)+ does not support this model\b/i.test(text);
}

function claudeEnvironment(
  model?: string | null,
  source: NodeJS.ProcessEnv = process.env,
  configDir?: string,
  instanceEnvironment: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, PATH: augmentedPath(), NPM_CONFIG_LOGLEVEL: "error" };
  if (configDir?.trim()) {
    env.CLAUDE_CONFIG_DIR = resolveClaudeConfigDir(configDir, env);
    for (const key of CLAUDE_ACCOUNT_ENV_KEYS) {
      if (key.startsWith("CLAUDE_CODE_OAUTH_") || key.endsWith("_FILE_DESCRIPTOR") || !Object.hasOwn(instanceEnvironment, key)) {
        delete env[key];
      }
    }
  } else if (env.CLAUDE_CONFIG_DIR) {
    env.CLAUDE_CONFIG_DIR = resolveClaudeConfigDir(undefined, env);
  }
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SILENT_TURN_REMINDER;
  stripWorkspaceCredentialEnv(env);
  const applied = applyClaudeInject(env, model);
  if (!applied.injected && !instanceEnvironment.ANTHROPIC_API_KEY) delete env.ANTHROPIC_API_KEY;
  return env;
}

function inheritsUserConfig(env: NodeJS.ProcessEnv): boolean {
  return env.LATERDOG_CLAUDE_INHERIT_USER_CONFIG === "1";
}

export function claudeInheritWarning(env: NodeJS.ProcessEnv): ProviderSnapshot["warning"] | undefined {
  if (!inheritsUserConfig(env)) return undefined;
  return {
    title: "Bots inherit this machine's Claude Code setup",
    message:
      "LATERDOG_CLAUDE_INHERIT_USER_CONFIG=1 is set on the later.dog process, so every Claude bot also loads this " +
      "computer's own MCP servers, connectors, skills, hooks and personal CLAUDE.md on every turn — often thousands " +
      "of extra tokens per model call, and tools nobody gave the bot. Unless a bot genuinely needs a server from " +
      "your user-scope Claude config, remove the variable and restart; add the server under Settings → MCP servers " +
      "or the bot project's .mcp.json instead.",
  };
}

export function readClaudeAuthSettings(
  env: NodeJS.ProcessEnv,
  instanceEnvironment: NodeJS.ProcessEnv = {},
): { env?: Record<string, string>; apiKeyHelper?: string } {
  if (CLAUDE_ACCOUNT_ENV_KEYS.some((key) => instanceEnvironment[key])) return {};
  try {
    const settings = JSON.parse(readFileSync(join(resolveClaudeConfigDir(undefined, env), "settings.json"), "utf8"));
    const authEnv: Record<string, string> = {};
    for (const key of CLAUDE_ACCOUNT_ENV_KEYS) {
      if (!key.endsWith("_FILE_DESCRIPTOR") && typeof settings?.env?.[key] === "string") {
        authEnv[key] = settings.env[key];
      }
    }
    return {
      ...(Object.keys(authEnv).length ? { env: authEnv } : {}),
      ...(typeof settings?.apiKeyHelper === "string" && settings.apiKeyHelper.trim()
        ? { apiKeyHelper: settings.apiKeyHelper } : {}),
    };
  } catch {
    return {};
  }
}

function projectMcpServers(cwd: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
  } catch {
    return {};
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
  const out: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers as Record<string, unknown>)) {
    if (server && typeof server === "object" && !Array.isArray(server)) out[name] = server;
  }
  return out;
}

export function autoCompactWindow(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.LATERDOG_CLAUDE_AUTOCOMPACT ?? "").trim().toLowerCase();
  if (raw === "off") return null;
  if (raw === "auto") return "auto";
  const parsed = raw ? Number(raw) : DEFAULT_AUTOCOMPACT_TOKENS;
  if (!Number.isFinite(parsed) || parsed <= 0) return String(DEFAULT_AUTOCOMPACT_TOKENS);
  return String(Math.min(1_000_000, Math.max(100_000, Math.floor(parsed))));
}

const DEFAULT_AUTOCOMPACT_TOKENS = 200_000;

export const CLAUDE_FLAG_FLOORS = {
  "--strict-mcp-config": [1, 0, 60],
  "--setting-sources": [1, 0, 122],
  "--autocompact": [2, 1, 122],
  "--system-prompt-snapshot": [2, 1, 267],
  "--restricted": [2, 1, 257],
} as const satisfies Record<string, ClaudeCliVersion>;

const withWhy = (refusal: string, why: string | undefined) => why ? `${refusal} ${why}` : refusal;

export const GUEST_CLAUDE_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "WebSearch"] as const;
const GUEST_FORBIDDEN_TOOLS = new Set(["Bash", "PowerShell", "WebFetch", "BashOutput", "KillShell", "KillBash", "NotebookEdit", "Task", "Agent"]);
export const GUEST_CLAUDE_PERMISSIONS = {
  blockReadsOutsideWorkingDirectories: true,
  deny: ["Bash", "PowerShell", "WebFetch", "Read(//proc/**)"],
} as const;

export type ClaudeCliVersion = readonly [number, number, number];

export const CLAUDE_CONTEXT_CONTROL_MIN_VERSION: ClaudeCliVersion = CLAUDE_FLAG_FLOORS["--system-prompt-snapshot"];

export const CLAUDE_REPLAY_FLOOR: ClaudeCliVersion = [2, 1, 282];

export function parseClaudeCliVersion(stdout: string | null | undefined): ClaudeCliVersion | null {
  return parseVersionTriple(stdout ?? "");
}

export function claudeCliSupports(version: ClaudeCliVersion | null, flag: keyof typeof CLAUDE_FLAG_FLOORS): boolean {
  return version === null || versionAtLeast(version, CLAUDE_FLAG_FLOORS[flag]);
}

export function claudeCliUpdate(version: string | null, cli: string): ProviderSnapshot["update"] | undefined {
  const parsed = parseClaudeCliVersion(version);
  if (!parsed || versionAtLeast(parsed, CLAUDE_CONTEXT_CONTROL_MIN_VERSION)) return undefined;
  const floor = CLAUDE_CONTEXT_CONTROL_MIN_VERSION.join(".");
  const missing = (Object.keys(CLAUDE_FLAG_FLOORS) as (keyof typeof CLAUDE_FLAG_FLOORS)[])
    .filter((flag) => !claudeCliSupports(parsed, flag));
  const effects = [
    ...(missing.includes("--autocompact") ? ["no compaction window picked by later.dog"] : []),
    ...(missing.includes("--setting-sources") ? ["bots still see this machine's own Claude Code setup"] : []),
    ...(missing.includes("--system-prompt-snapshot") ? ["resumed turns cannot refresh stale system prompts"] : []),
  ];
  return {
    title: "Update Claude Code for context controls",
    message:
      `Claude Code ${parsed.join(".")} predates ${floor}, so bots run without ${missing.join(", ")}: ` +
      `${effects.join("; ")}. Update it, then refresh Engines.`,
    command: cli === "claude" ? "claude update" : `${cli} update`,
  };
}

const DRIVER_KIND = "claudeAgent";

const NO_ANTHROPIC_KEY = "No Anthropic API key — add one in the model picker.";

export interface ClaudeConfig {
  cli: string;
  configDir?: string;
  managed?: boolean;
  managedModels?: string[];
  permissionMode: "acceptEdits" | "auto" | "bypassPermissions";
  tools?: string[];
  disallowedTools?: string[];
  requireApiKey?: boolean;
}

const CLAUDE_5_EFFORT: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

export const STATIC_CLAUDE_MODELS: ModelCatalog = {
  default: "claude-sonnet-5",
  options: [
    { id: "claude-fable-5-1", label: "Claude Fable 5.1", effortLevels: CLAUDE_5_EFFORT, defaultEffort: "high" },
    { id: "claude-fable-5", label: "Claude Fable 5", effortLevels: CLAUDE_5_EFFORT, defaultEffort: "high" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", contextWindow: 1_000_000, effortLevels: CLAUDE_5_EFFORT, defaultEffort: "medium" },
    { id: "claude-opus-5", label: "Claude Opus 5", effortLevels: CLAUDE_5_EFFORT, defaultEffort: "high" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", contextWindow: 1_000_000, effortLevels: CLAUDE_5_EFFORT, defaultEffort: "medium" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", effortLevels: CLAUDE_5_EFFORT, defaultEffort: "high" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", contextWindow: 1_000_000, effortLevels: CLAUDE_5_EFFORT, defaultEffort: "medium" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", effortLevels: [] },
  ],
};

const CLAUDE_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]*$/i;
const OFFICIAL_CLAUDE_ID = /^claude-[a-z0-9.-]+$/;

async function resolveClaudeTurnModel(
  model: string | null | undefined,
  env: Record<string, string | undefined>,
): Promise<string | null | undefined> {
  if (!model || decodeInjectId(model) || STATIC_CLAUDE_MODELS.options.some((option) => option.id === model)) {
    return model;
  }
  return resolveInjectId(model, await probeLocalInjects(env)) ?? model;
}

function extrasFromUnknown(value: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") {
      return CLAUDE_MODEL_ID.test(item) ? [{ id: item, label: item }] : [];
    }
    if (!item || typeof item !== "object") return [];
    const row = item as { id?: unknown; model?: unknown; slug?: unknown; name?: unknown; displayName?: unknown; label?: unknown };
    const id = [row.id, row.model, row.slug].find((candidate): candidate is string => typeof candidate === "string");
    if (!id || !CLAUDE_MODEL_ID.test(id)) return [];
    const label = [row.name, row.displayName, row.label].find((candidate): candidate is string => typeof candidate === "string");
    return [{ id, label: label || id }];
  });
}

export function readClaudeModelCatalog(env: Record<string, string | undefined> = process.env) {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(join(resolveClaudeConfigDir(undefined, env), "settings.json"), "utf8")) as Record<string, unknown>;
  } catch {
    settings = {};
  }

  const extras = [
    ...extrasFromUnknown(settings.availableModels).map((extra) => ({ ...extra, custom: true })),
    ...extrasFromUnknown(settings.customModels).map((extra) => ({ ...extra, custom: true })),
    ...extrasFromUnknown(settings.extraModels).map((extra) => ({ ...extra, custom: !OFFICIAL_CLAUDE_ID.test(extra.id) })),
  ];
  const nestedEnv = settings.env && typeof settings.env === "object" ? (settings.env as Record<string, unknown>) : {};
  const envModel = nestedEnv.ANTHROPIC_MODEL ?? env.ANTHROPIC_MODEL;
  if (typeof envModel === "string") extras.push(...extrasFromUnknown([envModel]).map((extra) => ({ ...extra, custom: true })));

  const options = STATIC_CLAUDE_MODELS.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    if (seen.has(extra.id)) continue;
    seen.add(extra.id);
    options.push(extra.custom || extra.id === envModel
      ? { id: extra.id, label: extra.label, custom: true }
      : { id: extra.id, label: extra.label });
  }
  return { default: STATIC_CLAUDE_MODELS.default, options };
}

const PERM_PROXY_PATH = SPAWNED_PROXIES.permission;
const DWEB_PROXY_PATH = SPAWNED_PROXIES.dweb;
const HOOK_HELPER_PATH = SPAWNED_PROXIES.hook;
const NODE_ENV_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

function removePrivateTempDir(filePath: string | null | undefined): boolean {
  if (!filePath) return true;
  try {
    rmSync(dirname(filePath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    return true;
  } catch {
    return false;
  }
}

interface Ask {
  id: string;
  kind: "permission" | "question";
  tool: string;
  input: Record<string, unknown>;
  at: number;
}
type AskBehavior = "allow" | "deny" | "answer";
type AskResolutionSource = "user" | "timeout" | "system";

const DENY_TIMEOUT_NOTE =
  "later.dog: nobody answered this permission request in time. Skip this action and finish what you can without it.";
const QUESTION_TIMEOUT_NOTE = "later.dog: nobody answered in time. Use your best judgment and continue.";
const DUPLICATE_ASK_ID_NOTE = "later.dog: duplicate ask id — skipping this request.";

function systemEndedReply(kind: Ask["kind"]): { behavior: AskBehavior; message: string } {
  return kind === "question"
    ? { behavior: "answer", message: "later.dog: the turn is ending — wrap up." }
    : { behavior: "deny", message: "later.dog: the turn ended" };
}

function askQuestions(ask: Ask): AskQuestion[] | null {
  return ask.tool === ASK_USER_QUESTION_TOOL ? parseAskQuestions(ask.input) : null;
}

function askSummary(ask: Ask): string {
  const questions = askQuestions(ask);
  if (questions) return askQuestionSummary(questions);
  return askInputSummary(ask.input) ?? ask.tool ?? "tool";
}

export interface NativeTurnResult {
  ok: boolean;
  stopReason: string | null;
  cost: number | null;
  usage?: { input: number; output: number; cachedInput?: number };
}

export function sumNativeTurnResults(earlier: NativeTurnResult | null, latest: NativeTurnResult): NativeTurnResult {
  if (!earlier) return latest;
  const usage = earlier.usage && latest.usage
    ? {
        input: earlier.usage.input + latest.usage.input,
        output: earlier.usage.output + latest.usage.output,
        ...(earlier.usage.cachedInput !== undefined || latest.usage.cachedInput !== undefined
          ? { cachedInput: (earlier.usage.cachedInput ?? 0) + (latest.usage.cachedInput ?? 0) }
          : {}),
      }
    : latest.usage ?? earlier.usage;
  return {
    ok: earlier.ok && latest.ok,
    stopReason: latest.stopReason ?? earlier.stopReason,
    cost: latest.cost ?? earlier.cost,
    ...(usage ? { usage } : {}),
  };
}

export const STEERED_CONTINUATION_GRACE_MS = 2_000;

export const STEERED_CONTINUATION_SILENCE_MS = 30_000;

const fakeTimerScale = (name: string) => Number(process.env[name] ?? "1") || 1;
const steerGraceScale = () => fakeTimerScale("FAKE_CLAUDE_STEER_GRACE_SCALE");
const steerSilenceScale = () => fakeTimerScale("FAKE_CLAUDE_STEER_SILENCE_SCALE");

export function hookTokenFile(threadId: string, botId?: string): string {
  const digest = createHash("sha256").update(`${botId ?? ""}\0${threadId}`).digest("hex").slice(0, 24);
  return join(DATA_DIR, "hook-tokens", `${digest}.token`);
}

export function claudeHookSettings(helperPath: string): Record<string, unknown> {
  const command = process.platform === "win32"
    ? '"%LATERDOG_HOOK_NODE%" "%LATERDOG_HOOK_HELPER%"'
    : [process.execPath, helperPath].map(path => `'${path.replace(/'/g, "'\\''")}'`).join(" ");
  const entry = [{ matcher: "", hooks: [{ type: "command", command, timeout: 5 }] }];
  return { PostToolUse: entry, PreCompact: entry, SessionStart: entry, Stop: entry };
}

export function permissionSocketPath(threadId: string, botId?: string) {
  const key = botId ? `${botId}\0${threadId}` : threadId;
  const prefix = threadId.replace(/[^\w-]/g, "").slice(0, 4);
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 4);
  return brokerSocketPath(DATA_DIR, `${prefix}${digest}`);
}

export function brokerSocketCandidates(threadId: string, botId?: string): string[] {
  const base = permissionSocketPath(threadId, botId);
  if (process.platform !== "win32") {
    const scope = createHash("sha256")
      .update(`${DATA_DIR}\0${process.pid}\0${botId ?? ""}\0${threadId}`)
      .digest("hex")
      .slice(0, 16);
    return [base, join(tmpdir(), `laterdog-perm-${scope}.sock`)];
  }
  return [
    base,
    `${base}-${randomBytes(3).toString("hex")}`,
    `${base}-${randomBytes(3).toString("hex")}`,
  ];
}

export async function createPermissionBroker(opts: {
  socketPaths: string[];
  onAsk: (ask: Ask) => void;
  onResolve: (resolved: Ask & { behavior: AskBehavior; source: AskResolutionSource }) => void;
  isActive?: () => boolean;
  timeoutMs?: number;
}) {
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const pending = new Map<
    string,
    { ask: Ask; finish: (behavior: AskBehavior, message: string | undefined, source: AskResolutionSource, always?: boolean) => void }
  >();
  let closed = false;
  let boundPath = opts.socketPaths[0] ?? "";
  const connectionHandler = (conn: import("node:net").Socket) => {
    conn.on("error", () => {});
    conn.setEncoding("utf8");
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.t !== "ask") continue;
        const askId = String(msg.id ?? newId());
        const kind = msg.kind === "question" ? ("question" as const) : ("permission" as const);
        if (closed) {
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, ...systemEndedReply(kind) }) + "\n");
          } catch {}
          continue;
        }
        if (opts.isActive && !opts.isActive()) {
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, ...systemEndedReply(kind) }) + "\n");
          } catch {}
          continue;
        }
        if (pending.has(askId)) {
          console.error(`permission broker on ${boundPath}: duplicate ask id ${JSON.stringify(askId)} — denying`);
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, behavior: "deny", message: DUPLICATE_ASK_ID_NOTE }) + "\n");
          } catch {}
          continue;
        }
        const ask: Ask = { id: askId, kind, tool: msg.tool ?? "tool", input: msg.input ?? {}, at: Date.now() };
        const finish = (behavior: AskBehavior, message: string | undefined, source: AskResolutionSource, always?: boolean) => {
          if (!pending.delete(askId)) return;
          clearTimeout(timer);
          try {
            conn.write(
              JSON.stringify({ t: "answer", id: askId, behavior, message, source, ...(always ? { always: true } : {}) }) + "\n",
            );
          } catch {}
          opts.onResolve({ ...ask, behavior, source });
        };
        const timer = setTimeout(
          () =>
            kind === "question"
              ? finish("answer", QUESTION_TIMEOUT_NOTE, "timeout")
              : finish("deny", DENY_TIMEOUT_NOTE, "timeout"),
          timeoutMs,
        );
        timer.unref?.();
        pending.set(askId, { ask, finish });
        opts.onAsk(ask);
      }
    });
  };
  let server: ReturnType<typeof createNetServer> | null = null;
  for (const [index, candidate] of opts.socketPaths.entries()) {
    const attempt = createNetServer(connectionHandler);
    try {
      unlinkSync(candidate);
    } catch {}
    let outcome = await new Promise<"listening" | (Error & { code?: string })>((resolve) => {
      attempt.once("listening", () => resolve("listening"));
      attempt.once("error", (error) => resolve(error as Error & { code?: string }));
      attempt.listen(candidate);
    });
    if (outcome === "listening" && process.platform !== "win32") {
      try {
        chmodSync(candidate, 0o600);
      } catch (error) {
        try {
          attempt.close();
        } catch {}
        try {
          unlinkSync(candidate);
        } catch {}
        outcome = error as Error & { code?: string };
      }
    }
    if (outcome === "listening") {
      if (index > 0) {
        console.error(`permission broker: ${opts.socketPaths[0]} is still held — bound fallback ${candidate}`);
      }
      boundPath = candidate;
      server = attempt;
      attempt.on("error", (error) => {
        console.error(`permission broker error on ${candidate}: ${error.message}`);
      });
      break;
    }
    try {
      attempt.close();
    } catch {}
    if (index === opts.socketPaths.length - 1) {
      console.error(`permission broker unavailable on ${candidate}: ${outcome.message}`);
      break;
    }
  }
  if (!server) throw new Error("claude: permission broker could not bind a local socket");
  const drain = () => {
    for (const p of Array.from(pending.values())) {
      const { behavior, message } = systemEndedReply(p.ask.kind);
      p.finish(behavior, message, "system");
    }
  };
  return {
    answer(askId: string, behavior: AskBehavior, message?: string, always?: boolean): boolean {
      const p = pending.get(askId);
      if (!p) return false;
      if (p.ask.kind === "question" ? behavior !== "answer" : behavior === "answer") return false;
      p.finish(behavior, message, "user", always && behavior === "allow");
      return true;
    },
    pause() {
      drain();
    },
    close() {
      closed = true;
      drain();
      try {
        server?.close();
      } catch {}
      try {
        unlinkSync(boundPath);
      } catch {}
    },
    socketPath: boundPath,
  };
}

function decodeToolList(value: unknown, field: "tools" | "disallowedTools"): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`claude: ${field} must be an array of non-empty strings`);
  const decoded: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`claude: ${field} must be an array of non-empty strings`);
    }
    const normalized = entry.trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    decoded.push(normalized);
  }
  return decoded;
}

function decodeConfig(raw: unknown): ClaudeConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const mode = o.permissionMode;
  if (mode !== undefined && mode !== "acceptEdits" && mode !== "auto" && mode !== "bypassPermissions") {
    throw new Error(`claude: invalid permissionMode ${JSON.stringify(mode)}`);
  }
  const tools = decodeToolList(o.tools, "tools");
  const disallowedTools = decodeToolList(o.disallowedTools, "disallowedTools");
  if (o.configDir !== undefined && typeof o.configDir !== "string") throw new Error("claude: configDir must be a string");
  const configDir = typeof o.configDir === "string" ? o.configDir.trim() : undefined;
  if (configDir) resolveClaudeConfigDir(configDir);
  if (o.managedModels !== undefined && (o.managed !== true || !Array.isArray(o.managedModels) || !o.managedModels.length || o.managedModels.some(model => typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(model)))) throw new Error("Invalid hosted Claude models.");
  return {
    cli: typeof o.cli === "string" ? o.cli : "claude",
    ...(configDir ? { configDir } : {}),
    ...(o.managed === true ? { managed: true } : {}),
    ...(o.managedModels ? { managedModels: o.managedModels as string[] } : {}),
    permissionMode: (mode as ClaudeConfig["permissionMode"]) ?? "acceptEdits",
    ...(tools !== undefined ? { tools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(o.requireApiKey === true ? { requireApiKey: true } : {}),
  };
}

function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text" && b.text)
      .map((b) => b.text)
      .join("");
  }
  return "";
}

export function turnCostFromRunningTotal(total: number | null, previous: number | null): number | null {
  if (total === null) return null;
  if (previous === null || total < previous) return total;
  return Number((total - previous).toFixed(10));
}

export interface ClaudeCostSnapshot {
  total: number;
  models: Record<string, [number, number, number, number]>;
}

export function claudeCostSnapshot(total: unknown, modelUsage: unknown): ClaudeCostSnapshot | null {
  if (typeof total !== "number" || !Number.isFinite(total)) return null;
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const models: ClaudeCostSnapshot["models"] = {};
  if (modelUsage && typeof modelUsage === "object" && !Array.isArray(modelUsage)) {
    for (const [model, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const u = raw as Record<string, unknown>;
      models[model] = [count(u.inputTokens), count(u.cacheReadInputTokens), count(u.cacheCreationInputTokens), count(u.outputTokens)];
    }
  }
  return { total, models };
}

export function restoredCostBase(
  earlier: readonly ClaudeCostSnapshot[],
  current: ClaudeCostSnapshot,
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number },
): number {
  const turn = [usage.input, usage.cacheRead, usage.cacheWrite, usage.output];
  const nothing: ClaudeCostSnapshot = { total: 0, models: {} };
  let exact: number | null = null;
  let inside = 0;
  for (const state of [nothing, ...earlier]) {
    const within = Object.entries(state.models).every(([model, counts]) =>
      counts.every((n, i) => n <= (current.models[model]?.[i] ?? 0)));
    if (!within) continue;
    inside = state.total;
    const growth = Object.entries(current.models).map(([model, counts]) =>
      counts.map((n, i) => n - (state.models[model]?.[i] ?? 0)));
    const isTurn = (counts: number[]) => counts.every((n, i) => n === turn[i]);
    const summed = turn.map((_, i) => growth.reduce((sum, counts) => sum + counts[i]!, 0));
    if (growth.some(isTurn) || isTurn(summed)) exact = state.total;
  }
  return exact ?? inside;
}

const COST_HISTORY_FILE = join(DATA_DIR, "claude-cost-history.json");
const COST_HISTORY_SESSIONS = 100;
const COST_HISTORY_STATES = 8;

function isCostSnapshot(value: unknown): value is ClaudeCostSnapshot {
  if (!value || typeof value !== "object") return false;
  const { total, models } = value as { total?: unknown; models?: unknown };
  return typeof total === "number" && !!models && typeof models === "object" &&
    Object.values(models).every((counts) => Array.isArray(counts) && counts.length === 4 && counts.every((n) => typeof n === "number"));
}

function readCostHistory(): Record<string, ClaudeCostSnapshot[]> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(COST_HISTORY_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([id, states]) => [id, Array.isArray(states) ? states.filter(isCostSnapshot) : []]));
  } catch {
    return {};
  }
}

function recordCostState(sessionId: string, state: ClaudeCostSnapshot): void {
  const history = readCostHistory();
  const states = [...(history[sessionId] ?? []), state].slice(-COST_HISTORY_STATES);
  delete history[sessionId];
  history[sessionId] = states;
  const ids = Object.keys(history);
  for (const id of ids.slice(0, Math.max(0, ids.length - COST_HISTORY_SESSIONS))) delete history[id];
  try {
    writeFileAtomic(COST_HISTORY_FILE, JSON.stringify(history), { mode: 0o600, durable: false });
  } catch {}
}

type ClaudeImage = NonNullable<SendTurnInput["images"]>[number];
type ClaudeUserContent =
  | { type: "image"; source: { type: "base64"; media_type: ClaudeImage["mime"]; data: string } }
  | { type: "text"; text: string };
type ClaudeUserMessage = {
  type: "user";
  uuid?: string;
  message: { role: "user"; content: string | ClaudeUserContent[] };
};

function withVolatileNote(text: string, volatile: string): string {
  const body = volatile.trim()
    ? `This part of your instructions changed since this session started. It replaces the earlier copy:\n\n${volatile.trim()}`
    : "The notes that were in your instructions when this session started have been cleared.";
  const note = `<system-reminder>\n${body}\n</system-reminder>`;
  return text ? `${note}\n\n${text}` : note;
}

function claudeUserMessage(
  text: string,
  images: readonly ClaudeImage[] | undefined,
): ClaudeUserMessage {
  if (!images?.length) return { type: "user", message: { role: "user", content: text } };
  const content: ClaudeUserContent[] = images.map((image) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: image.mime,
      data: readFileSync(image.path).toString("base64"),
    },
  }));
  if (text) content.push({ type: "text", text });
  return { type: "user", message: { role: "user", content } };
}

function diagnosticClaudeUserMessage(message: ClaudeUserMessage): ClaudeUserMessage {
  if (!Array.isArray(message.message.content)) return message;
  return {
    ...message,
    message: {
      ...message.message,
      content: message.message.content.map((block) =>
        block.type === "image"
          ? {
              ...block,
              source: {
                ...block.source,
                data: `[image data: ${block.source.data.length} base64 chars]`,
              },
            }
          : block,
      ),
    },
  };
}

export const ClaudeDriver: ProviderDriver<ClaudeConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Claude", supportsMultipleInstances: true },
  install: {
    command: {
      darwin: "npm install -g @anthropic-ai/claude-code",
      linux: "npm install -g @anthropic-ai/claude-code",
      win32: "npm install -g @anthropic-ai/claude-code",
    },
    needsNode: true,
    docsUrl: "https://claude.com/claude-code",
    signInCommand: "claude",
  },
  models: STATIC_CLAUDE_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<ClaudeConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const environment = (model?: string | null) =>
      claudeEnvironment(config.managed ? undefined : model, { ...process.env, ...input.environment }, config.configDir, input.environment);
    const catalogEnv = environment();
    if (inheritsUserConfig(catalogEnv)) {
      console.error(`claude (${instanceId}): LATERDOG_CLAUDE_INHERIT_USER_CONFIG=1 — bots inherit this machine's Claude Code MCP servers, skills, hooks and CLAUDE.md on every turn; remove it unless a bot needs a user-scope server`);
    }
    let models = config.managedModels ? { default: config.managedModels[0], options: config.managedModels.map(id => ({ id, label: id })) } : STATIC_CLAUDE_MODELS;
    const refreshModels = async () => {
      if (config.managed) return;
      try {
        const resolved = await mergeLocalInject(readClaudeModelCatalog(catalogEnv), catalogEnv);
        if (resolved.options.length) models = resolved;
      } catch {}
    };
    await refreshModels();

    let cliVersion: ClaudeCliVersion | null = null;
    let cliVersionChecked = false;
    let cliHasAutocompact: boolean | null = null;
    let cliHelpVersion: string | null = null;
    const readCliVersion = (env: NodeJS.ProcessEnv): Promise<string | null> =>
      new Promise((resolve) => {
        execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
          resolve(err ? null : stdout.trim() || null),
        );
      });
    let helpRead: { version: string; done: Promise<void> } | null = null;
    const readCliHelp = (version: string, env: NodeJS.ProcessEnv): Promise<void> => {
      if (helpRead?.version === version) return helpRead.done;
      const read = {
        version,
        done: new Promise<string | null>((resolve) => {
          execCli(config.cli, ["--help"], { timeout: 8000, env }, (err, stdout) => resolve(err ? null : stdout));
        }).then((help) => {
          cliHasAutocompact = help === null ? null : /^\s*--autocompact\b/m.test(help);
          cliHelpVersion = version;
          if (helpRead === read) helpRead = null;
        }),
      };
      helpRead = read;
      return read.done;
    };
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { stop: () => void; turnId: string; broker?: Awaited<ReturnType<typeof createPermissionBroker>> }>();

    interface Session {
      child: ReturnType<typeof spawnCli>;
      broker?: Awaited<ReturnType<typeof createPermissionBroker>>;
      mcpConfigPath: string | null;
      systemPromptPath: string | null;
      argsKey: string;
      volatile: string;
      sessionId: string | null;
      sawInit: boolean;
      nativePermissionMode: string | null;
      replaysUserMessages: boolean;
      turn: {
        turnId: string;
        input: SendTurnInput;
        retryAbort: AbortController;
        settled: boolean;
        sawStreamDelta: boolean;
        awaitingInit?: boolean;
        authFailed?: boolean;
        updateRequired?: boolean;
        usageLimited?: boolean;
        rateLimit?: UsageLimit;
        stopRequested?: boolean;
        pendingSteers: Set<string>;
        deferred: NativeTurnResult | null;
        continuationGrace: ReturnType<typeof setTimeout> | null;
        armGrace?: () => void;
        continuationSilence: ReturnType<typeof setTimeout> | null;
      } | null;
      helperTurnId: string;
      helpers: ClaudeTasks;
      helperTimer: ReturnType<typeof setTimeout> | null;
      idleTimer: ReturnType<typeof setTimeout> | null;
      closing: boolean;
      stderr: string;
      costTotal: number | null | undefined;
      finishClose?: () => Promise<void>;
      closed: Promise<void>;
    }
    const sessions = new Map<string, Session>();
    const { idleMs: SESSION_IDLE_MS } = sessionIdlePolicy("CLAUDE");

    const stopSession = (session: Session) => {
      void killCliTree(session.child).then((stopped) => {
        if (stopped) void session.finishClose?.();
      });
    };
    const closeSession = (threadId: string, why: string) => {
      const s = sessions.get(threadId);
      if (!s || s.closing) return;
      s.closing = true;
      if (s.idleTimer) clearTimeout(s.idleTimer);
      const broker = s.broker;
      s.broker = undefined;
      broker?.close();
      appendNative(threadId, { dir: "out", source: "claude.session", msg: { close: why } });
      try {
        s.child.stdin.end();
      } catch {}
      const kill = setTimeout(() => {
        stopSession(s);
      }, 5_000);
      kill.unref?.();
    };
    const armIdle = (threadId: string) => {
      const s = sessions.get(threadId);
      if (!s || s.helpers.running()) return;
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.idleTimer = setTimeout(() => closeSession(threadId, "idle"), SESSION_IDLE_MS);
      s.idleTimer.unref?.();
    };
    const writeUser = (s: Session, threadId: string, promptMsg: ClaudeUserMessage): Promise<boolean> => {
      if (!s.child.stdin.writable || s.child.stdin.destroyed) return Promise.resolve(false);
      return new Promise((resolve) => {
        try {
          s.child.stdin.write(JSON.stringify(promptMsg) + "\n", (error) => {
            if (error) return resolve(false);
            appendNative(threadId, {
              dir: "out",
              source: "claude.sdk.message",
              msg: diagnosticClaudeUserMessage(promptMsg),
            });
            resolve(true);
          });
        } catch {
          resolve(false);
        }
      });
    };

    const emit = (event: RuntimeEvent) => {
      for (const l of Array.from(listeners)) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });
    const retryState = new Map<string, { attempt: number; cancelled: boolean; rebuilt?: boolean }>();

    const sendTurn = async (turn: SendTurnInput, logicalTurnId?: string) => {
      turn = { ...turn, toolScope: assertToolScopeSupported(DRIVER_KIND, turn.toolScope) };
      if (config.managedModels && (!turn.model || !config.managedModels.includes(turn.model))) throw new Error("This model is not assigned to this workspace.");
      if (config.requireApiKey && !input.environment.ANTHROPIC_API_KEY) throw new Error(NO_ANTHROPIC_KEY);
      if (config.managed && (!turn.model || turn.model.includes("::") || !config.configDir ||
          !input.environment.ANTHROPIC_API_KEY || !input.environment.ANTHROPIC_BASE_URL)) {
        throw new Error("Company model access is unavailable. Reconnect your organization; personal billing will not be used.");
      }
      const { threadId, botId } = turn;
      const relaunch = logicalTurnId !== undefined;
      if (!relaunch) {
        const stopped = sessions.get(threadId);
        if (stopped?.turn?.stopRequested && active.get(threadId)?.turnId === stopped.turn.turnId &&
            await killCliTree(stopped.child)) await stopped.closed;
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      }
      const permissionMode = turn.approvalMode === undefined
        ? config.permissionMode
        : turn.approvalMode === "full" ? "bypassPermissions"
          : turn.approvalMode === "auto" ? "auto"
            : turn.approvalMode === "edits" ? "acceptEdits" : "default";
      const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
      if (controlsHost && permissionMode === "bypassPermissions" && turn.approvalMode !== "full") {
        throw new Error("local computer control requires the interactive approval broker");
      }
      const promptMsg = claudeUserMessage(turn.text, turn.images);
      const turnId = logicalTurnId ?? newId();
      const retryAbort = new AbortController();
      const retry = retryState.get(threadId) ?? { attempt: 0, cancelled: false };
      if (!relaunch) {
        retry.cancelled = false;
        retry.rebuilt = false;
      }
      retryState.set(threadId, retry);
      const retryScale = Number(process.env.FAKE_CLAUDE_RETRY_SCALE ?? "1");
      const sessionId = !turn.sessionReset && typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
      const newSessionId = sessionId ? null : newId();

      const args = [
        "-p",
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode", permissionMode,
      ];
      if (turn.guestConfined && permissionMode !== "default") {
        throw new Error("A guest's turn on this Cloud runs only in Ask.");
      }
      if (turn.guestConfined) args.push("--restricted", "--tools", GUEST_CLAUDE_TOOLS.join(","));
      else if (config.tools !== undefined) args.push("--tools", config.tools.join(","));
      if (config.disallowedTools?.length) {
        args.push("--disallowedTools", config.disallowedTools.join(","));
      }
      const turnEnvironment = environment();
      if (!cliVersionChecked) {
        const version = await readCliVersion(turnEnvironment);
        if (version) {
          cliVersion = parseClaudeCliVersion(version);
          cliVersionChecked = true;
        }
      }
      if (turn.guestConfined && !claudeCliSupports(cliVersion, "--restricted")) {
        throw new Error(withWhy("This Claude Code is too old to run this turn without a shell. Update Claude Code.", turn.confinedWhy));
      }
      const replaysUserMessages = cliVersion === null || versionAtLeast(cliVersion, CLAUDE_REPLAY_FLOOR);
      if (replaysUserMessages) args.push("--replay-user-messages");
      const isolated = !inheritsUserConfig(turnEnvironment);
      if (turn.toolScope !== undefined && (!isolated || turn.mcpFromUserConfig || cliVersion === null || !claudeCliSupports(cliVersion, "--strict-mcp-config"))) {
        throw new Error("Claude cannot confirm a restricted MCP configuration for this account. Disable inherited Claude MCP servers and use a current, identifiable Claude CLI before using tool selection.");
      }
      if (isolated) {
        if (!turn.mcpFromUserConfig && claudeCliSupports(cliVersion, "--strict-mcp-config")) args.push("--strict-mcp-config");
        if (claudeCliSupports(cliVersion, "--setting-sources")) args.push("--setting-sources", "project");
      }
      const compactWindow = autoCompactWindow(turnEnvironment);
      if (compactWindow && cliHasAutocompact === true) {
        args.push("--autocompact", compactWindow);
      }
      if (cliVersionChecked && claudeCliSupports(cliVersion, "--system-prompt-snapshot")) {
        args.push("--system-prompt-snapshot", "off");
      }
      const turnModel = config.managed ? turn.model : await resolveClaudeTurnModel(turn.model, turnEnvironment);
      const injected = config.managed ? { model: turnModel ?? null, injected: false } : applyClaudeInject({ ...turnEnvironment }, turnModel);
      if (injected.model) args.push("--model", injected.model);
      if (turn.effort) args.push("--effort", claudeEffortArg(turn.effort));

      let systemPromptPath: string | null = null;

      const mcpServers: Record<string, unknown> = {};
      const allowed: string[] = [];
      if (turn.integrations?.composio) {
        mcpServers.composio = { ...turn.integrations.composio };
        allowed.push("mcp__composio");
      }
      if (turn.integrations?.localComputer) {
        const local = turn.integrations.localComputer;
        mcpServers.computer = {
          command: local.command,
          args: local.args,
          env: local.env,
        };
        if (!controlsHost) allowed.push("mcp__computer");
      }
      if (turn.integrations?.agents) {
        mcpServers.agents = { ...turn.integrations.agents, alwaysLoad: true };
        allowed.push("mcp__agents");
      }
      if (turn.integrations?.phone) {
        mcpServers.phone = { ...turn.integrations.phone };
        allowed.push("mcp__phone");
      }
      if (turn.integrations?.browser) {
        mcpServers.browser = { ...turn.integrations.browser };
        allowed.push("mcp__browser");
      }
      if (turn.integrations?.dweb) {
        mcpServers.dweb = {
          command: process.execPath,
          args: [DWEB_PROXY_PATH],
          env: {
            ...NODE_ENV_FLAG,
            DWEB_URL: turn.integrations.dweb.url,
          },
        };
        allowed.push("mcp__dweb");
      }
      const botOwned = new Set<string>();
      for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
        if (Object.hasOwn(mcpServers, name)) continue;
        mcpServers[name] = { ...server };
        botOwned.add(name);
      }
      if (isolated && turn.cwd && !turn.guestConfined) {
        for (const [name, server] of Object.entries(projectMcpServers(turn.cwd))) {
          if (Object.hasOwn(mcpServers, name)) continue;
          mcpServers[name] = server;
          botOwned.add(name);
        }
      }
      const budget = resultBudget(turnEnvironment);
      for (const name of turn.toolScope === undefined ? botOwned : Object.keys(mcpServers)) {
        if (!canUseMcpServer(turn.toolScope, name)) { delete mcpServers[name]; continue; }
        const gated = gateServer({ name, server: mcpServers[name], threadId, budget: botOwned.has(name) ? budget : 0, nodeEnv: NODE_ENV_FLAG, toolScope: turn.toolScope });
        if (gated) mcpServers[name] = { ...gated, ...((mcpServers[name] as { alwaysLoad?: unknown })?.alwaysLoad === true ? { alwaysLoad: true } : {}) };
      }
      allowed.splice(0, allowed.length, ...allowed.filter((name) => Object.hasOwn(mcpServers, name.slice("mcp__".length))));
      allowed.push(...laterdogPreallowedTools(turn.integrations?.custom ?? {}, mcpServers));
      let broker: Awaited<ReturnType<typeof createPermissionBroker>> | undefined;
      const socketPath = permissionSocketPath(threadId, botId);
      if (permissionMode !== "bypassPermissions") {
        args.push("--permission-prompt-tool", "mcp__dog__approve");
      }
      const permissionEnv = { ...NODE_ENV_FLAG, ...(turn.toolScope !== undefined ? { LATERDOG_PERMISSION_TOOL_SCOPE: JSON.stringify(turn.toolScope) } : {}) };
      mcpServers.dog = { command: process.execPath, args: [PERM_PROXY_PATH, socketPath], env: permissionEnv, alwaysLoad: true };
      allowed.push("mcp__dog");
      if (turn.guestConfined) allowed.splice(0, allowed.length, ...allowed.filter((name) => name === "mcp__dog" || name === "mcp__agents"));
      let mcpConfigPath: string | null = null;
      if (Object.keys(mcpServers).length) {
        mcpConfigPath = join(mkdtempSync(join(tmpdir(), "laterdog-mcp-")), "mcp.json");
        args.push("--mcp-config", mcpConfigPath);
        args.push("--allowedTools", allowed.join(","));
      }

      const env = environment(turnModel);
      const authSettings = isolated && !injected.injected
        ? readClaudeAuthSettings(env, input.environment) : {};
      const hooks = turn.integrations?.hooks;
      const hookTokenPath = hooks ? hookTokenFile(threadId, botId) : null;
      if (hooks && hookTokenPath) {
        mkdirSync(dirname(hookTokenPath), { recursive: true, mode: 0o700 });
        writeFileAtomicIfChanged(hookTokenPath, hooks.token, { mode: 0o600, durable: false });
        env.LATERDOG_HOOK_URL = hooks.url;
        env.LATERDOG_HOOK_TOKEN_FILE = hookTokenPath;
        env.LATERDOG_HOOK_NODE = process.execPath;
        env.LATERDOG_HOOK_HELPER = HOOK_HELPER_PATH;
        if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
      }
      const settings: Record<string, unknown> = { ...authSettings };
      if (isolated) settings.claudeMdExcludes = machineClaudeMemoryExcludes(env);
      if (hooks) settings.hooks = claudeHookSettings(HOOK_HELPER_PATH);
      if (turn.guestConfined) settings.permissions = GUEST_CLAUDE_PERMISSIONS;
      if (turn.fast) settings.fastMode = true;
      const authSettingsPath = mcpConfigPath && Object.keys(settings).length
        ? join(dirname(mcpConfigPath), "auth-settings.json") : null;
      if (authSettingsPath) args.push("--settings", authSettingsPath);
      env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
      Object.assign(env, quietWorkEnvironment(turn.quietWork));
      const cwd = turn.cwd ?? homedir();
      const commandCwd = permissionLaunchCwd(cwd);
      const privateFileFlags = new Set(["--mcp-config", "--settings"]);
      const keyArgs = args.filter((a, i) => !privateFileFlags.has(a) && !privateFileFlags.has(args[i - 1] ?? ""));
      const argsKey = JSON.stringify({
        args: keyArgs,
        system: turn.systemStable ?? turn.system ?? null,
        mcpServers,
        cwd,
        model: injected.model ?? null,
        base: env.ANTHROPIC_BASE_URL ?? null,
        configDir: env.CLAUDE_CONFIG_DIR ?? null,
        hooks: Boolean(hooks),
        fast: Boolean(turn.fast),
        quiet: Boolean(turn.quietWork),
        auth: createHash("sha256").update(JSON.stringify({
          settings: authSettings,
          env: Object.fromEntries(CLAUDE_ACCOUNT_ENV_KEYS.map((key) => [key, env[key]])),
        })).digest("hex"),
      });

      const live = sessions.get(threadId);
      if (!turn.sessionReset && live && !live.turn && !live.closing && live.child.exitCode === null && live.argsKey === argsKey && (!sessionId || sessionId === live.sessionId)) {
        if (live.idleTimer) clearTimeout(live.idleTimer);
        live.helpers.beginTurn();
        live.helperTurnId = turnId;
        live.turn = { turnId, input: turn, retryAbort, settled: false, sawStreamDelta: false, awaitingInit: true, pendingSteers: new Set(), deferred: null, continuationGrace: null, continuationSilence: null };
        active.set(threadId, { stop: () => {
          if (live.turn) live.turn.stopRequested = true;
          closeSession(threadId, "interrupted");
          retry.cancelled = true;
          retryAbort.abort();
          stopSession(live);
        }, turnId, broker: live.broker });
        emit({ ...base(threadId, turnId), type: "turn.started" });
        const volatile = turn.systemVolatile ?? "";
        const message = volatile === live.volatile && !turn.mentionTurn
          ? promptMsg
          : claudeUserMessage(withVolatileNote(turn.text, volatile), turn.images);
        live.volatile = volatile;
        const running = live.turn;
        if (!(await writeUser(live, threadId, message)) && !running?.stopRequested) closeSession(threadId, "stdin write failed");
        if (mcpConfigPath) {
          try {
            rmSync(dirname(mcpConfigPath), { recursive: true, force: true });
          } catch {}
        }
        return { turnId };
      }
      if (live) closeSession(threadId, turn.sessionReset ? "context reset" : "spawn contract changed");

      const cleanupUnownedLaunch = () => {
        broker?.close();
        broker = undefined;
        if (mcpConfigPath) {
          try {
            rmSync(dirname(mcpConfigPath), { recursive: true, force: true });
          } catch {}
          mcpConfigPath = null;
        }
        if (systemPromptPath) {
          removePrivateTempDir(systemPromptPath);
          systemPromptPath = null;
        }
        retryState.delete(threadId);
      };

      try {
        if (turn.system) {
          systemPromptPath = join(mkdtempSync(join(tmpdir(), "laterdog-system-")), "prompt.txt");
          writeFileSync(systemPromptPath, turn.system, { mode: 0o600 });
          args.push("--append-system-prompt-file", systemPromptPath);
        }
        if (socketPath) {
          const askTools = new Map<string, string | undefined>();
          broker = await createPermissionBroker({
            socketPaths: brokerSocketCandidates(threadId, botId),
            isActive: () => Boolean(sessions.get(threadId)?.turn),
            onAsk: (ask) => {
              const eventTurnId = sessions.get(threadId)?.turn?.turnId ?? turnId;
              askTools.set(ask.id, typeof ask.tool === "string" ? ask.tool : undefined);
              const nativeMode = sessions.get(threadId)?.nativePermissionMode ?? null;
              const nativeReview =
                permissionMode === "auto" && nativeMode !== null
                  ? nativeMode === "auto" ? "active" : "inactive"
                  : undefined;
              const questions = askQuestions(ask);
              emit({
                ...base(threadId, eventTurnId),
                type: "request.opened",
                requestId: ask.id,
                requestType: ask.kind,
                tool: ask.tool,
                summary: askSummary(ask),
                command: ask.kind === "permission" && ask.tool === "Bash"
                  ? permissionCommand(ask.input.command, commandCwd) : undefined,
                requiresExplicitApproval: ask.kind === "permission" && ask.tool === "Bash" && ask.input.dangerouslyDisableSandbox === true || undefined,
                nativeReview,
                allowSession: ask.kind === "permission" && !(controlsHost && typeof ask.tool === "string" && ask.tool.startsWith("mcp__computer")) ? true : undefined,
                approvalScope:
                  typeof ask.tool === "string" && controlsHost && ask.tool.startsWith("mcp__computer")
                    ? "local-computer"
                    : undefined,
                questions: questions ?? undefined,
                choices: questions ? questionChoices(questions) : parseChoices(ask.input?.choices),
              });
            },
            onResolve: (resolved) => {
              const eventTurnId = sessions.get(threadId)?.turn?.turnId ?? turnId;
              emit({
                ...base(threadId, eventTurnId),
                type: "request.resolved",
                requestId: resolved.id,
                behavior: resolved.behavior,
                source: resolved.source,
                approvalScope:
                  controlsHost && typeof askTools.get(resolved.id) === "string" && askTools.get(resolved.id)!.startsWith("mcp__computer") ? "local-computer" : undefined,
              });
              askTools.delete(resolved.id);
            },
          });
          if (broker.socketPath !== socketPath && mcpConfigPath) {
            mcpServers.dog = { command: process.execPath, args: [PERM_PROXY_PATH, broker.socketPath], env: permissionEnv, alwaysLoad: true };
          }
        }

        if (mcpConfigPath) {
          writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
        }
        if (authSettingsPath) {
          writeFileSync(authSettingsPath, JSON.stringify(settings), { mode: 0o600 });
        }
        if (sessionId) args.push("--resume", sessionId);
        else args.push("--session-id", newSessionId!);
      } catch (error) {
        cleanupUnownedLaunch();
        throw error;
      }

      if (relaunch && retry.cancelled) {
        cleanupUnownedLaunch();
        if (active.get(threadId)?.turnId === turnId) active.delete(threadId);
        emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "interrupted", cost: null });
        return { turnId };
      }

      let child: ReturnType<typeof spawnCli>;
      try {
        child = spawnCli(config.cli, args, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        cleanupUnownedLaunch();
        throw error;
      }
      let markClosed!: () => void;
      const session: Session = {
        closed: new Promise<void>((resolve) => { markClosed = resolve; }),
        child,
        broker,
        mcpConfigPath,
        systemPromptPath,
        argsKey,
        volatile: turn.systemVolatile ?? "",
        sessionId: sessionId ?? newSessionId,
        sawInit: false,
        nativePermissionMode: null,
        replaysUserMessages,
        turn: { turnId, input: turn, retryAbort, settled: false, sawStreamDelta: false, pendingSteers: new Set(), deferred: null, continuationGrace: null, continuationSilence: null },
        helperTurnId: turnId,
        helpers: new ClaudeTasks((helper) => emit({ ...base(threadId, session.turn?.turnId ?? session.helperTurnId), type: "helper.updated", helper })),
        helperTimer: null,
        idleTimer: null,
        closing: false,
        stderr: "",
        costTotal: undefined,
      };
      sessions.set(threadId, session);

      const settle = (
        ok: boolean,
        stopReason: string | null,
        total: number | null = null,
        usage?: { input: number; output: number; cachedInput?: number },
      ) => {
        const t = session.turn;
        if (!t || t.settled) return;
        t.settled = true;
        if (session.helperTimer) clearTimeout(session.helperTimer);
        session.helperTimer = null;
        if (session.helpers.running()) {
          closeSession(threadId, "helpers stopped at turn end");
          stopSession(session);
        }
        if (t.continuationGrace) {
          clearTimeout(t.continuationGrace);
          t.continuationGrace = null;
        }
        if (t.continuationSilence) {
          clearTimeout(t.continuationSilence);
          t.continuationSilence = null;
        }
        session.broker?.pause();
        if (session.mcpConfigPath) {
          try {
            rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
          } catch {}
          session.mcpConfigPath = null;
        }
        if (session.systemPromptPath) {
          if (removePrivateTempDir(session.systemPromptPath)) session.systemPromptPath = null;
        }
        active.delete(threadId);
        session.turn = null;
        retryState.delete(threadId);
        if (stopReason === "update_required") closeSession(threadId, "update required");
        const cost = turnCostFromRunningTotal(total, session.costTotal ?? null);
        if (total !== null) session.costTotal = total;
        emit({ ...base(threadId, t.turnId), type: "turn.completed", ok, stopReason, cost, ...(usage ? { usage } : {}) });
        if (session.child.exitCode === null && !session.closing) armIdle(threadId);
      };
      const settleResult = (result: NativeTurnResult) => settle(result.ok, result.stopReason, result.cost, result.usage);
      const currentTurnId = () => session.turn?.turnId ?? session.helperTurnId;
      const continueAfterHelpers = (): boolean => {
        const held = session.turn;
        if (!held?.deferred || held.settled || held.stopRequested || session.helpers.backgroundRunning()) return false;
        if (session.helpers.continuationLimitReached()) {
          emit({ ...base(threadId, held.turnId), type: "runtime.error", message: "Your dog reached the limit for consecutive helper rounds. Check its reported results before continuing." });
          settle(false, "helper_continuation_limit");
          return true;
        }
        if (!session.helpers.takeContinuation()) return false;
        void writeUser(session, threadId, claudeUserMessage("Your background helpers have finished. Review their reported results, complete the original request, and reply. Do not repeat work that is already complete.", undefined)).then((written) => {
          if (!written && session.turn === held && !held.settled) {
            emit({ ...base(threadId, held.turnId), type: "runtime.error", message: "Your helpers finished, but their results could not be delivered to the dog." });
            settle(false, "helper_continuation_failed");
          }
        });
        return true;
      };
      const noteCostState = (total: unknown, modelUsage: unknown, usage: Parameters<typeof restoredCostBase>[2]) => {
        const state = claudeCostSnapshot(total, modelUsage);
        if (!state) return;
        if (session.costTotal === undefined) {
          session.costTotal = session.sessionId
            ? restoredCostBase(readCostHistory()[session.sessionId] ?? [], state, usage)
            : null;
        }
        if (session.sessionId) recordCostState(session.sessionId, state);
      };

      const handleLine = (line: string) => {
        if (session.closing) return;
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        appendNative(threadId, { dir: "in", source: "claude.sdk.message", msg: o?.type === "user" && o.isReplay === true && o.message ? diagnosticClaudeUserMessage(o) : o });
        if (session.turn?.continuationSilence && !(o.type === "system" && o.subtype === "init") && !(o.type === "user" && o.isReplay === true)) {
          clearTimeout(session.turn.continuationSilence);
          session.turn.continuationSilence = null;
        }
        switch (o.type) {
          case "system":
            if (session.helpers.receive(o)) {
              if (session.helpers.running() && session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null; }
              if (session.helpers.running() && !session.helperTimer) {
                const helperMaxMs = Math.min(2_147_483_647, Math.max(1_000, Number(input.environment.LATERDOG_HELPERS_MAX_MS ?? process.env.LATERDOG_HELPERS_MAX_MS) || 4 * 60 * 60_000));
                session.helperTimer = setTimeout(() => {
                  if (!session.helpers.running()) return;
                  emit({ ...base(threadId, currentTurnId()), type: "runtime.error", message: "Your helpers reached their time limit and are being stopped." });
                  const runningTurn = active.get(threadId);
                  if (runningTurn) runningTurn.stop();
                  else { closeSession(threadId, "helper time limit"); stopSession(session); }
                }, helperMaxMs);
                session.helperTimer.unref?.();
              }
              if (!session.helpers.running() && session.helperTimer) {
                clearTimeout(session.helperTimer);
                session.helperTimer = null;
              }
              break;
            }
            if (o.subtype === "init") {
              const tools: unknown[] = Array.isArray(o.tools) ? o.tools : [];
              if (session.turn?.input.guestConfined && (o.permissionMode !== "default" || tools.some((tool) => typeof tool === "string" && GUEST_FORBIDDEN_TOOLS.has(tool)))) {
                emit({ ...base(threadId, currentTurnId()), type: "runtime.error", message: withWhy("This Claude Code kept its shell, so it can't run this turn. Update Claude Code.", session.turn?.input.confinedWhy) });
                session.closing = true;
                stopSession(session);
                break;
              }
              session.sawInit = true;
              if (session.turn) session.turn.awaitingInit = false;
              session.nativePermissionMode = typeof o.permissionMode === "string" ? o.permissionMode : null;
              if (typeof o.session_id === "string") session.sessionId = o.session_id;
              const held = session.turn;
              if (held?.continuationGrace) {
                clearTimeout(held.continuationGrace);
                held.continuationGrace = null;
                if (held.continuationSilence) clearTimeout(held.continuationSilence);
                held.continuationSilence = setTimeout(() => {
                  if (session.turn !== held || held.settled || !held.deferred) return;
                  if (held.stopRequested || session.closing) return;
                  held.continuationSilence = null;
                  emit({
                    ...base(threadId, held.turnId),
                    type: "runtime.error",
                    message: "Claude began a steered message but went silent; the turn was closed.",
                  });
                  settleResult(held.deferred);
                }, STEERED_CONTINUATION_SILENCE_MS * steerSilenceScale());
                held.continuationSilence.unref?.();
              }
              emit({ ...base(threadId, currentTurnId()), type: "session.started", sessionId: o.session_id, model: o.model, ...(retry.rebuilt ? { rebuilt: true } : {}) });
            } else if (o.subtype === "thinking_tokens") {
              emit({ ...base(threadId, currentTurnId()), type: "item.updated", itemType: "reasoning", tokens: o.estimated_tokens });
            }
            break;
          case "stream_event": {
            if (o.parent_tool_use_id) break;
            const ev = o.event ?? {};
            if (ev.type !== "content_block_delta") break;
            const d = ev.delta ?? {};
            if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
              if (session.turn) session.turn.sawStreamDelta = true;
              emit({ ...base(threadId, currentTurnId()), type: "content.delta", streamKind: "assistant_text", delta: d.text });
            } else if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
              emit({ ...base(threadId, currentTurnId()), type: "content.delta", streamKind: "reasoning_text", delta: d.thinking });
            }
            break;
          }
          case "assistant": {
            const msg = o.message ?? {};
            const text = firstText(msg.content);
            if (claudeAuthFailure(o, text)) {
              if (session.turn) session.turn.authFailed = true;
              emit({ ...base(threadId, currentTurnId()), type: "runtime.error", message: text, setup: true });
              break;
            }
            if (claudeVersionTooOld(o, text)) {
              if (session.turn) session.turn.updateRequired = true;
              emit({ ...base(threadId, currentTurnId()), type: "runtime.error", message: text, setup: true, claudeUpdate: true });
              break;
            }
            const limit = claudeUsageLimit(o, text, Date.now(), session.turn?.rateLimit);
            if (limit) {
              if (session.turn) session.turn.usageLimited = true;
              emit({
                ...base(threadId, currentTurnId()),
                type: "runtime.error",
                message: text.trim() || "This Claude account reached its usage limit.",
                terminal: true,
                quota: limit,
              });
              break;
            }
            if (text.trim()) {
              const synthetic = o.is_api_error_message === true || typeof o.error === "string" ? { synthetic: true } : {};
              if (!session.turn?.sawStreamDelta) {
                emit({ ...base(threadId, currentTurnId()), ...synthetic, type: "content.delta", streamKind: "assistant_text", delta: text });
              }
              if (session.turn) session.turn.sawStreamDelta = false;
              emit({ ...base(threadId, currentTurnId()), ...synthetic, type: "item.completed", itemType: "assistant_text", text });
            }
            for (const b of Array.isArray(msg.content) ? msg.content : []) {
              if (b.type === "tool_use") {
                emit({
                  ...base(threadId, currentTurnId()),
                  type: "item.started",
                  itemType: "tool",
                  itemId: b.id,
                  title: b.name,
                  summary: commandSummary(b.input),
                  input: toolDetailPreview(b.input),
                });
              }
            }
            if (msg.usage) {
              emit({
                ...base(threadId, currentTurnId()),
                type: "thread.token-usage.updated",
                input: (msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0),
                output: msg.usage.output_tokens || 0,
                ...(typeof msg.usage.cache_read_input_tokens === "number"
                  ? { cachedInput: msg.usage.cache_read_input_tokens }
                  : {}),
                contextTokens: (msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0) + (msg.usage.cache_creation_input_tokens || 0),
              });
            }
            break;
          }
          case "rate_limit_event": {
            const rejected = rejectedRateLimit(o.rate_limit_info);
            if (rejected && session.turn) session.turn.rateLimit = rejected;
            break;
          }
          case "user": {
            if (o.isReplay === true) {
              if (typeof o.uuid === "string") session.turn?.pendingSteers.delete(o.uuid);
              break;
            }
            for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
              if (b.type === "tool_result") {
                emit({ ...base(threadId, currentTurnId()), type: "item.completed", itemType: "tool", itemId: b.tool_use_id, ok: !b.is_error, output: toolDetailPreview(b.content) });
                for (const img of extractMcpImages(b.content)) {
                  emit({ ...base(threadId, currentTurnId()), type: "item.completed", itemType: "assistant_image", itemId: b.tool_use_id, data: img.data });
                }
              }
            }
            break;
          }
          case "result": {
            if (o.origin?.kind === "task-notification") {
              continueAfterHelpers();
              break;
            }
            noteCostState(o.total_cost_usd, o.modelUsage, {
              input: o.usage?.input_tokens || 0,
              cacheRead: o.usage?.cache_read_input_tokens || 0,
              cacheWrite: o.usage?.cache_creation_input_tokens || 0,
              output: o.usage?.output_tokens || 0,
            });
            const native: NativeTurnResult = {
              ok: o.is_error !== true,
              stopReason: session.turn?.authFailed
                ? "auth_required"
                : session.turn?.updateRequired
                  ? "update_required"
                  : session.turn?.usageLimited
                    ? "usage_limit"
                    : o.stop_reason ?? o.terminal_reason ?? null,
              cost: o.total_cost_usd ?? null,
              ...(o.usage
                ? {
                    usage: {
                      input: (o.usage.input_tokens || 0) + (o.usage.cache_read_input_tokens || 0) + (o.usage.cache_creation_input_tokens || 0),
                      output: o.usage.output_tokens || 0,
                      ...(typeof o.usage.cache_read_input_tokens === "number"
                        ? { cachedInput: o.usage.cache_read_input_tokens }
                        : {}),
                    },
                  }
                : {}),
            };
            const t = session.turn;
            if (t && !t.settled && session.helpers.backgroundRunning() && native.ok && !t.usageLimited && !t.authFailed && !t.updateRequired) {
              t.deferred = sumNativeTurnResults(t.deferred, native);
              if (t.continuationGrace) clearTimeout(t.continuationGrace);
              t.continuationGrace = null;
              break;
            }
            const queuedTurns = typeof o.queued_turn_count === "number" ? o.queued_turn_count : 0;
            if (t && !t.settled && (queuedTurns > 0 || t.pendingSteers.size > 0)) {
              if (!session.replaysUserMessages) t.pendingSteers.clear();
              t.deferred = sumNativeTurnResults(t.deferred, native);
              t.armGrace = () => {
                if (t.continuationGrace) clearTimeout(t.continuationGrace);
                t.continuationGrace = setTimeout(() => {
                  if (session.turn !== t || t.settled) return;
                  if (t.stopRequested || session.closing) return;
                  t.continuationGrace = null;
                  if (t.deferred) settleResult(t.deferred);
                }, STEERED_CONTINUATION_GRACE_MS * steerGraceScale());
                t.continuationGrace.unref?.();
              };
              t.armGrace();
              appendNative(threadId, { dir: "out", source: "claude.session", msg: { hold: `result: a steered message is still queued (queued_turn_count ${o.queued_turn_count ?? "absent"})` } });
              break;
            }
            if (t && native.ok && !t.usageLimited && !t.authFailed && !t.updateRequired) {
              const earlier = t.deferred;
              t.deferred = sumNativeTurnResults(earlier, native);
              if (continueAfterHelpers()) break;
              t.deferred = earlier;
            }
            settleResult(sumNativeTurnResults(t?.deferred ?? null, native));
            break;
          }
        }
      };

      let buf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) handleLine(line);
        }
      });

      child.stderr.on("data", (c) => {
        session.stderr += c;
        if (session.stderr.length > 8192) session.stderr = session.stderr.slice(-8192);
      });

      child.on("error", (e) => {
        emit({ ...base(threadId, currentTurnId()), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
        settle(false, "spawn_error");
      });

      let closeFinalized = false;
      const finalizeClose = async (code: number | null) => {
        if (closeFinalized) return;
        if (!(await killCliTree(child, 0))) {
          session.broker?.close();
          session.broker = undefined;
          emit({ ...base(threadId, currentTurnId()), type: "runtime.error", message: "Claude could not be confirmed stopped; its helper processes may still be running." });
          return;
        }
        if (closeFinalized) return;
        closeFinalized = true;
        if (session.helperTimer) clearTimeout(session.helperTimer);
        session.helperTimer = null;
        if (session.helpers.stop()) emit({ ...base(threadId, currentTurnId()), type: "runtime.error", message: "The helpers stopped with this turn." });
        if (session.turn?.stopRequested && !session.turn.settled) {
          settle(false, "interrupted");
        } else if (session.turn?.deferred && !session.turn.settled) {
          const held = session.turn.deferred;
          if (session.turn.continuationGrace) {
            settleResult(held);
          } else {
            emit({
              ...base(threadId, currentTurnId()),
              type: "runtime.error",
              message: `claude exited ${code} before result${session.stderr ? `: ${session.stderr.trim().slice(-300)}` : ""}`,
            });
            settleResult({ ...held, ok: false, stopReason: "exit_before_result" });
          }
        } else if (session.turn?.usageLimited && !session.turn.settled) {
          retryState.delete(threadId);
          settle(false, "usage_limit");
        } else if (session.turn && !session.turn.settled) {
          const { turnId, input: turn, retryAbort } = session.turn;
          const retry = retryState.get(threadId) ?? { attempt: 0, cancelled: false };
          const message = `claude exited ${code} before result${session.stderr ? `: ${session.stderr.trim().slice(-300)}` : ""}`;
          const verdict = classifyError({ exitCode: code, stderr: message });
          const endedBeforeTurn = session.turn.awaitingInit === true;
          if (
            !retry.cancelled &&
            (endedBeforeTurn || (
              code !== 0 &&
              verdict.transient &&
              !session.turn.sawStreamDelta &&
              retry.attempt < RETRY_MAX_ATTEMPTS - 1
            ))
          ) {
            const failedBroker = session.broker;
            session.broker = undefined;
            failedBroker?.pause();
            failedBroker?.close();
            if (session.mcpConfigPath) {
              try {
                rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
              } catch {}
              session.mcpConfigPath = null;
            }
            if (session.systemPromptPath) {
              removePrivateTempDir(session.systemPromptPath);
              session.systemPromptPath = null;
            }
            sessions.delete(threadId);
            session.turn = null;
            let delayMs = 0;
            if (!endedBeforeTurn) {
              retry.attempt++;
              delayMs = computeBackoff(retry.attempt - 1);
              emit({
                ...base(threadId, turnId),
                type: "turn.retrying",
                attempt: retry.attempt,
                delayMs,
                reason: verdict.reason,
              });
            }
            void (async () => {
              const wait = interruptibleDelay(delayMs * retryScale, retryAbort.signal);
              await wait.promise;
              if (retry.cancelled) {
                active.delete(threadId);
                retryState.delete(threadId);
                emit({
                  ...base(threadId, turnId),
                  type: "turn.completed",
                  ok: false,
                  stopReason: "interrupted",
                  cost: null,
                });
                return;
              }
              retryState.set(threadId, retry);
              active.set(threadId, { stop: () => { retry.cancelled = true; retryAbort.abort(); }, turnId });
              try {
                const cursor = session.sessionId ?? sessionId ?? undefined;
                await sendTurn({ ...turn, sessionReset: false, resumeCursor: cursor }, turnId);
              } catch (e) {
                if (active.get(threadId)?.turnId === turnId) active.delete(threadId);
                retryState.delete(threadId);
                emit({
                  ...base(threadId, turnId),
                  type: "runtime.error",
                  message: e instanceof Error ? e.message : String(e),
                });
                emit({
                  ...base(threadId, turnId),
                  type: "turn.completed",
                  ok: false,
                  stopReason: "exit_before_result",
                  cost: null,
                });
              }
            })();
            return;
          }
          const resumeFailure = classifyResumeFailure({
            attempted: Boolean(sessionId),
            rejected: !session.sawInit,
            promptSubmitted: session.sawInit,
            producedOutput: session.turn.sawStreamDelta,
          });
          if (mayReplay(resumeFailure) && !retry.cancelled) {
            const recovery = recoveryPromptFor({
              recoveryText: turn.recoveryText,
              currentText: turn.text,
              failure: resumeFailure,
            });
            session.broker?.close();
            session.broker = undefined;
            if (session.mcpConfigPath) {
              try {
                rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
              } catch {}
              session.mcpConfigPath = null;
            }
            if (session.systemPromptPath) {
              removePrivateTempDir(session.systemPromptPath);
              session.systemPromptPath = null;
            }
            sessions.delete(threadId);
            session.turn = null;
            retry.rebuilt = recovery.replayed;
            retryState.set(threadId, retry);
            active.set(threadId, { stop: () => { retry.cancelled = true; retryAbort.abort(); }, turnId });
            emit({
              ...base(threadId, turnId),
              type: "turn.retrying",
              attempt: retry.attempt + 1,
              delayMs: 0,
              reason: "resume_rejected",
            });
            void (async () => {
              try {
                await sendTurn({ ...turn, resumeCursor: undefined, recoveryText: undefined, text: recovery.text }, turnId);
              } catch (e) {
                if (active.get(threadId)?.turnId === turnId) active.delete(threadId);
                retryState.delete(threadId);
                emit({
                  ...base(threadId, turnId),
                  type: "runtime.error",
                  message: e instanceof Error ? e.message : String(e),
                });
                emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "exit_before_result", cost: null });
              }
            })();
            return;
          }
          retryState.delete(threadId);
          emit({
            ...base(threadId, currentTurnId()),
            type: "runtime.error",
            message,
          });
          settle(false, "exit_before_result");
        }
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.broker?.close();
        if (session.mcpConfigPath) {
          try {
            rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
          } catch {}
        }
        removePrivateTempDir(session.systemPromptPath);
        if (sessions.get(threadId) === session) sessions.delete(threadId);
      };
      child.on("close", (code) => {
        session.finishClose = () => finalizeClose(code);
        void session.finishClose().finally(markClosed);
      });

      const stop = () => {
        if (session.turn) session.turn.stopRequested = true;
        closeSession(threadId, "interrupted");
        retry.cancelled = true;
        retryAbort.abort();
        stopSession(session);
      };
      active.set(threadId, { stop, turnId, broker });
      emit({ ...base(threadId, turnId), type: "turn.started" });

      if (!(await writeUser(session, threadId, promptMsg))) {
        if (!session.turn?.stopRequested) settle(false, "stdin_write_failed");
        closeSession(threadId, "stdin write failed");
      }

      return { turnId };
    };

    const steer = async (threadId: string, text: string, images?: readonly ClaudeImage[]): Promise<SteerOutcome> => {
      const s = sessions.get(threadId);
      if (!s || !s.turn || s.turn.settled || s.closing || s.child.exitCode !== null) return "refused";
      const turn = s.turn;
      const id = randomUUID();
      turn.pendingSteers.add(id);
      if (!(await writeUser(s, threadId, { ...claudeUserMessage(text, images), uuid: id }))) {
        turn.pendingSteers.delete(id);
        return "refused";
      }
      if (!turn.settled && turn.continuationGrace) turn.armGrace?.();
      return "steered";
    };

    const login = new ClaudeLoginController({ cli: config.cli, environment, onAuthenticated: async () => { await refreshModels(); } });

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const env = environment();
      const version = await readCliVersion(env);
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      cliVersion = parseClaudeCliVersion(version);
      cliVersionChecked = true;
      if (version !== cliHelpVersion) await readCliHelp(version, env);
      const update = claudeCliUpdate(version, config.cli);
      const warning = claudeInheritWarning(env);
      if (config.requireApiKey) {
        if (!input.environment.ANTHROPIC_API_KEY) return { state: "unavailable", version, reason: NO_ANTHROPIC_KEY };
        return { state: "available", version, authenticated: true, account: { method: "api-key" }, ...(update ? { update } : {}), ...(warning ? { warning } : {}), billing: "metered" };
      }
      const auth = await claudeAuthStatus(config.cli, env);
      return { state: "available", version, ...auth, ...(update ? { update } : {}), ...(warning ? { warning } : {}), billing: "subscription" };
    };

    const generateReview = (prompt: string, signal?: AbortSignal, onUsage?: TextGenerationOptions["onUsage"]): Promise<string> =>
      new Promise((resolve, reject) => {
        if (config.requireApiKey && !input.environment.ANTHROPIC_API_KEY) {
          reject(new Error(NO_ANTHROPIC_KEY));
          return;
        }
        const model = config.managedModels?.[0] ?? "claude-haiku-4-5";
        const child = spawnCli(
          config.cli,
          ["-p", "--model", model, "--output-format", onUsage ? "json" : "text"],
          {
            stdio: ["pipe", "pipe", "pipe"],
            env: environment(model),
          },
        );
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve(stdout.trim());
        };
        const onAbort = () => {
          killCliTree(child);
          finish(new Error("Claude review aborted"));
        };
        const timer = setTimeout(() => {
          killCliTree(child);
          finish(new Error("Claude review timed out"));
        }, 60_000);
        timer.unref?.();
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.length > 1_000_000) {
            killCliTree(child);
            finish(new Error("Claude review output exceeded 1 MB"));
          }
        });
        child.stderr.on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-8_192);
        });
        child.on("error", (error) => finish(error));
        child.on("close", (code) => {
          if (settled) return;
          if (onUsage) {
            try {
              const result = JSON.parse(stdout);
              if (!result || result.type !== "result") throw new Error("Claude text generation returned no result");
              const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
              const cachedInput = count(result.usage?.cache_read_input_tokens);
              const inputs = [count(result.usage?.input_tokens), cachedInput, count(result.usage?.cache_creation_input_tokens)]
                .filter((value): value is number => value !== undefined);
              const models = result.modelUsage && typeof result.modelUsage === "object" && !Array.isArray(result.modelUsage)
                ? Object.keys(result.modelUsage) : [];
              onUsage({
                model: models.length === 1 ? models[0]! : models.find(candidate => candidate === model || candidate.startsWith(`${model}-`)) ?? model,
                input: inputs.length ? inputs.reduce((sum, value) => sum + value, 0) : undefined,
                output: count(result.usage?.output_tokens),
                cachedInput,
                costUsd: count(result.total_cost_usd),
              });
              if (result.is_error === true) throw new Error(typeof result.result === "string" && result.result.trim() ? result.result : stderr.trim() || "Claude text generation failed");
              if (typeof result.result !== "string") throw new Error("Claude text generation returned no text");
              stdout = result.result;
            } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)));
              return;
            }
          }
          if (code === 0) finish();
          else finish(new Error(stderr.trim() || `Claude review exited ${code}`));
        });
        if (signal?.aborted) onAbort();
        else {
          signal?.addEventListener("abort", onAbort, { once: true });
          child.stdin.end(prompt);
        }
      });

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return models;
      },
      refreshModels,
      snapshot,
      startAuthentication: () => login.start(),
      getAuthentication: (flowId) => login.get(flowId),
      completeAuthentication: (flowId, code) => login.complete(flowId, code),
      cancelAuthentication: () => login.cancel(),
      signOut: () => login.signOut(),
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          sessionModelSwitch: "in-session",
          guestTurns: "confined",
          agentsMcp: true,
        customMcp: true,
          computerMcp: true,
          composioMcp: true,
          phoneMcp: true,
          browserMcp: true,
          images: true,
          nativeImageInput: true,
          get effortLevels() {
            return claudeEffortLevels(cliVersionChecked ? cliVersion : null);
          },
          fastMode: true,
          queueing: true,
          steerImages: true,
          get strictResume() {
            return cliVersionChecked && cliVersion !== null && claudeCliSupports(cliVersion, "--system-prompt-snapshot");
          },
          localComputerMcp: true,
          hooks: true,
        },
        sendTurn,
        steer,
        interruptTurn: async (threadId) => active.get(threadId)?.stop(),
        respondToRequest: async (threadId, requestId, decision) => {
          const broker = sessions.get(threadId)?.broker ?? active.get(threadId)?.broker;
          if (!broker) return "unavailable";
          const behavior = decision.behavior === "answer" ? "answer" : decision.behavior;
          if (!broker.answer(requestId, behavior, decision.message, decision.always)) return "unavailable";
          return behavior === "allow" ? "allowed-once" : behavior === "answer" ? "answered" : "rejected";
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { stop } of active.values()) stop();
          for (const threadId of Array.from(sessions.keys())) closeSession(threadId, "stopAll");
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: (prompt, options) => generateReview(prompt, options?.signal, options?.onUsage),
      reviewPermission: generateReview,
      dispose: async () => {
        try {
          await login.dispose();
        } finally {
          for (const { stop } of active.values()) stop();
          for (const threadId of Array.from(sessions.keys())) closeSession(threadId, "dispose");
          listeners.clear();
        }
      },
    };
  },
};
