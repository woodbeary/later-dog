import { homedir } from "node:os";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

import { PROVIDER_CREDENTIAL_ENV, stripControlPlaneEnv, WORKSPACE_CREDENTIAL_ENV } from "../../config.ts";
import { decodeInjectId } from "../local-inject.ts";
import { DeviceAuthController, type DeviceSignIn } from "../device-auth.ts";
import { deletePromptSplitReceipt, promptHalves, readPromptSplitReceipt, splitSessionPrompt, writePromptSplitReceipt } from "../prompt-split.ts";
import type { PromptSplitReceipt } from "../prompt-split.ts";
import { describeSpawnFailure, killCliTree, spawnCli } from "../../procs.ts";
import {
  classifyQuiet, describeQuiet, lastSeenPhrase, LogTail, quietKey, sampleProcessTree,
  type LogSignal, type ProcessSample, type QuietState,
} from "./quiet-status.ts";

export function skipSubscriptionAuthForLocalInject(model: string | undefined): boolean {
  return Boolean(decodeInjectId(model));
}

export function acpNativeIncomingLogMessage(message: any, privateResponses: ReadonlySet<number>): unknown {
  if (!privateResponses.has(message?.id)) return message;
  return { jsonrpc: message.jsonrpc, id: message.id, ...(message.error !== undefined ? { error: "[MCP catalog error omitted]" } : { result: "[MCP catalog omitted]" }) };
}

import type {
  DriverCreateInput,
  EffortLevel,
  EngineInstall,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  ModelCatalog,
  ModelVariantOption,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  ProviderErrorCode,
  RequestOutcome,
  TurnImageInput,
} from "../../contracts.ts";
import { newEventId, newId, TurnNotStartedError } from "../../contracts.ts";
import { augmentedPath } from "../../env-path.ts";
import { supportsApprovalMode } from "../../../shared/approval-mode.ts";
import { MAX_QUESTION_TEXT, parseAskQuestions, parseChoices, questionAnswersByQuestion } from "../../../shared/ask-question.ts";

import { appendNative } from "../native.ts";
import { acpPermissionCommand, permissionLaunchCwd } from "../permission-command.ts";
import { commandSummary, toolDetailPreview } from "../../tool-summary.ts";
import { extractMcpImages } from "../../mcp-tool-images.ts";
import { redactSecretsInText } from "../../redact.ts";
import { recoveryPromptFor } from "../../resume-recovery.ts";
import { sessionIdlePolicy } from "../session-idle.ts";
import { classifyError } from "../retry.ts";
import { canUseMcpServer, narrowsNativeTools, parseToolScope } from "../../../shared/tool-scope.ts";
import { gateServer } from "../../mcp-gate-config.ts";
import { readEngineModels } from "../../laterdog/wait-at-most.ts";
import { readCliVersion, unreadCli } from "../../laterdog/cli-version.ts";

export type AccountErrorCode = Extract<ProviderErrorCode,
  "invalid_credentials" | "inactive_subscription" | "insufficient_funds" | "quota_or_region_restriction">;
const ACCOUNT_ERROR_CODES: ReadonlySet<ProviderErrorCode> = new Set<AccountErrorCode>([
  "invalid_credentials", "inactive_subscription", "insufficient_funds", "quota_or_region_restriction",
]);
const isAccountError = (code: ProviderErrorCode | undefined): code is AccountErrorCode =>
  code !== undefined && ACCOUNT_ERROR_CODES.has(code);

function acpRpcError(value: any, method: string): Error {
  const message = typeof value?.message === "string" ? value.message : "ACP request failed";
  const data = value?.data;
  const detail = typeof data === "string" ? data
    : typeof data?.details === "string" ? data.details
    : typeof data?.message === "string" ? data.message
    : typeof data?.error?.message === "string" ? data.error.message
    : "";
  const context = [
    method,
    typeof data?.service === "string" ? `service: ${data.service}` : "",
    typeof data?.errorName === "string" ? data.errorName : "",
  ].filter(Boolean).join(", ");
  const diagnostic = `${detail && detail !== message ? `${message}: ${detail}` : message} (${context})`;
  const error = new Error(redactSecretsInText(diagnostic).slice(0, 1500));
  return Object.assign(error, { code: value?.code, data,
    acpSessionFailure: value?.code === -32603,
  });
}

export interface AcpConfig {
  cli: string;
  fullAuto: boolean;
  workspace?: string;
}

type AcpAskFinish = (
  behavior: string,
  source?: "user" | "timeout" | "system",
  message?: string,
  always?: boolean,
) => RequestOutcome;

interface AcpTurn {
  turnId: string;
  turn: SendTurnInput;
  turnConfig: AcpConfig;
  controlsHost: boolean;
  state: {
    settled: boolean; promptSent: boolean; text: string; producedItem: boolean; startupActivity: boolean; stopped: boolean;
    usagePeak: number | null;
    usageLast: number | null;
    usageCompacted: boolean;
  };
  acknowledge: () => void;
  asks: Map<string, AcpAskFinish>;
  runningTools: Set<string>;
  unkeyedToolIds: string[];
  interruptTimer: ReturnType<typeof setTimeout> | null;
  stopQuietWatch: (() => void) | null;
  flushAssistantText: () => void;
  receiveModelVariants: (result: any) => void;
}

interface AcpConnection {
  send(obj: unknown): void;
  request(
    method: string,
    params: unknown,
    timeoutMs?: number,
    receive?: (result: any) => void,
    idleMs?: number,
    idleMessage?: string | (() => string),
  ): Promise<any>;
  readonly lastInboundAt: number;
  touch(): void;
  failAll(error: Error): void;
  close(): void;
}

interface AcpSession {
  child: ReturnType<typeof spawnCli>;
  acp: AcpConnection;
  launch: { command: string; args?: string[] };
  env: Record<string, string | undefined>;
  cwd: string;
  contractKey: string;
  sessionKey: string | null;
  sessionId: string | null;
  sessionConfigResult: any;
  initResult: any;
  authenticated: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
  dead: boolean;
  stderr: string;
  current: AcpTurn | null;
  fallbackNotice?: string;
  launchModel?: string;
}

export interface AcpSupport {
  toolScopeSessionParams?(turn: SendTurnInput, initializeResult: unknown, hasMcp: boolean,
    context: { config: AcpConfig; env: Record<string, string | undefined>; cwd: string }): Record<string, unknown>;
  toolScopeCacheKey?(context: { config: AcpConfig; env: Record<string, string | undefined>; cwd: string }): string;
  driverKind: string;
  displayName: string;
  access?: "subscription" | "custom";
  models: { default: string; options: Array<{ id: string; label: string }> };
  effortLevels?: readonly EffortLevel[];
  modelVariants?: boolean;
  defaultCli: string;
  resolveModels?(
    environment: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
  ): ModelCatalog | Promise<ModelCatalog>;
  resolveModelsOnCreate?: boolean;
  nativeSource: string;
  images?: boolean;
  acceptsUnadvertisedImages?(initializeResult: unknown): boolean;
  loginNote: string;
  install?: EngineInstall;
  deviceSignIn?: DeviceSignIn;
  spawnArgs(config: AcpConfig, turn: SendTurnInput): string[];
  credentialEnv?: readonly string[];
  selectModel?: { configId: string };
  fallbackModel?(sessionConfig: unknown, catalogDefault: string): string | null;
  sessionModelEnv?: string;
  spawnFingerprint?(env: Record<string, string | undefined>): string;
  sessionScopedApproval?: boolean;
  transformEnv?(
    env: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
    instanceEnvironment: Readonly<Record<string, string>>,
  ): void;
  resolveCommand?(
    env: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
  ): Promise<{ command: string; args?: string[]; env?: Record<string, string | undefined> }>;
  snapshot?(
    env: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
  ): Promise<ProviderSnapshot>;
  resumeMethod?: "load" | "resume";
  restartOnMcpChange?: boolean;
  clientFileSystem?: boolean;
  redactStderr?: boolean;
  statusLog?: {
    path(env: Record<string, string | undefined>, sessionId: string): string | null;
    parse(line: string): LogSignal | null;
  };
  sanitizeToolPayload?: boolean;
  applyTurnEnv?(
    env: Record<string, string | undefined>,
    ctx: { model?: string; requestedModel?: string; fullAuto: boolean; botId?: string; cwd: string; toolScope?: SendTurnInput["toolScope"] },
  ): void;
  pickAuthMethod(authMethods: Array<{ id?: string }>): string | null;
  authFailure: "fail" | "continue";
  isAuthenticated(
    env: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
  ): boolean | Promise<boolean>;
  requireAuthenticationBeforeSpawn?: boolean;
  classifyError?(error: unknown): ProviderErrorCode | undefined;
  describeAccountError?(code: AccountErrorCode, model?: string): string;
  buildPromptText?(turn: SendTurnInput): string;
  resolveTurnModel?(
    model: string | undefined,
    env: Record<string, string | undefined>,
  ): string | undefined;
  configureSession?(ctx: {
    request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>;
    sessionId: string;
    config: AcpConfig;
    turn: SendTurnInput;
    sessionModels: Array<{ modelId?: string; name?: string }>;
    currentModelId?: string;
  }): Promise<void>;
}

const envOr = (key: string, fallback: number): number => Number(process.env[key] ?? fallback);
const INIT_TIMEOUT = 300_000;
const SESSION_CONFIG_TIMEOUT = 300_000;
const NEW_SESSION_TIMEOUT = 300_000;
const LOAD_SESSION_TIMEOUT = 120_000;
const ACP_STUCK_AFTER_MS = 180_000;
const ACP_PROMPT_RE_ANCHOR_TURNS = 8;
const ACP_COMPACTION_COLLAPSE_RATIO = 0.6;
export const DEFAULT_ACP_PROMPT_IDLE_MS = 15 * 60_000;
const promptIdleTimeoutMs = (): number => {
  const raw = process.env.LATERDOG_ACP_PROMPT_IDLE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_ACP_PROMPT_IDLE_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
};
const formatQuietLimit = (ms: number): string =>
  ms >= 120_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;
function trackRunningTool(current: AcpTurn, update: { toolCallId?: unknown; status?: unknown }, defaultStatus?: "pending"): void {
  if (typeof update.toolCallId !== "string" || !update.toolCallId) return;
  const status = update.status ?? defaultStatus;
  if (status === "completed" || status === "failed") current.runningTools.delete(update.toolCallId);
  else if (status === "pending" || status === "in_progress") current.runningTools.add(update.toolCallId);
}

let unkeyedToolSeq = 0;
function nextUnkeyedToolId(current: AcpTurn): string {
  const id = `acp-tool-unkeyed-${++unkeyedToolSeq}`;
  current.unkeyedToolIds.push(id);
  return id;
}
const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;

function acpVariantOption(result: any): { configId: string; options: ModelVariantOption[]; currentValue?: string } | undefined {
  const option = (Array.isArray(result?.configOptions) ? result.configOptions : []).find(
    (entry: any) => entry?.type === "select" && typeof entry.id === "string"
      && (entry.id === "effort" || entry.category === "thought_level"),
  );
  if (!option) return;
  const options: ModelVariantOption[] = [];
  const seen = new Set<string>();
  const collect = (entries: unknown) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (typeof entry?.value === "string" && !seen.has(entry.value)) {
        seen.add(entry.value);
        options.push({ id: entry.value, label: typeof entry.name === "string" ? entry.name : entry.value });
      } else if (Array.isArray(entry?.options)) collect(entry.options);
    }
  };
  collect(option.options);
  return {
    configId: option.id,
    options,
    ...(typeof option.currentValue === "string" ? { currentValue: option.currentValue } : {}),
  };
}
const TOOL_LOG_TEXT_LIMIT = 64_000;

export function offeredModels(result: any, configId: string): string[] {
  const option = (Array.isArray(result?.configOptions) ? result.configOptions : []).find(
    (entry: any) => entry?.id === configId,
  );
  const ids: string[] = [];
  const visit = (entries: unknown) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (typeof entry?.value === "string") ids.push(entry.value);
      else if (Array.isArray(entry?.options)) visit(entry.options);
    }
  };
  visit(option?.options);
  return ids;
}

async function readAcpImageBlocks(images: readonly TurnImageInput[]) {
  return Promise.all(images.map(async (image) => ({
    type: "image" as const,
    data: (await readFile(image.path)).toString("base64"),
    mimeType: image.mime,
  })));
}

function sanitizeToolLogValue(value: unknown, budget: { nodes: number; text: number }, depth = 0): unknown {
  if (depth > 12 || budget.nodes-- <= 0) return undefined;
  if (typeof value === "string") {
    if (/^data:image\//iu.test(value) || budget.text <= 0) return undefined;
    const limit = Math.min(TOOL_LOG_TEXT_LIMIT, budget.text);
    const text = value.length <= limit ? value : `[Earlier output truncated]\n\n${value.slice(-limit)}`;
    budget.text -= text.length;
    return text;
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const sanitized = sanitizeToolLogValue(entry, budget, depth + 1);
      return sanitized === undefined ? [] : [sanitized];
    });
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).flatMap(([key, entry]) => {
    if ((record.type === "image" && (key === "data" || key === "blob")) ||
      (key === "blob" && typeof record.mimeType === "string" && record.mimeType.startsWith("image/"))) return [];
    const sanitized = sanitizeToolLogValue(entry, budget, depth + 1);
    return sanitized === undefined ? [] : [[key, sanitized]];
  }));
}

function sanitizeAcpToolMessage(message: any): unknown {
  const isToolUpdate = message?.method === "session/update"
    && ["tool_call", "tool_call_update"].includes(message?.params?.update?.sessionUpdate);
  const isPermission = message?.method === "session/request_permission";
  if (!isToolUpdate && !isPermission) return message;
  return sanitizeToolLogValue(message, { nodes: 512, text: TOOL_LOG_TEXT_LIMIT });
}

function decodeAcpConfig(defaultCli: string) {
  return (raw: unknown): AcpConfig => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      cli: typeof o.cli === "string" ? o.cli : defaultCli,
      fullAuto: o.fullAuto === true,
      workspace: typeof o.workspace === "string" ? o.workspace : undefined,
    };
  };
}

function sessionOperationKey(toolCall: any): string | null {
  const rawInput = toolCall?.rawInput;
  const command = typeof rawInput?.command === "string" ? rawInput.command : undefined;
  const hasInput = rawInput && typeof rawInput === "object" && Object.keys(rawInput).length > 0;
  if (!command && !hasInput) return null;
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]))
        : value;
  return JSON.stringify(stable({
    kind: toolCall?.kind,
    title: toolCall?.title,
    command,
    input: rawInput,
    locations: toolCall?.locations,
  }));
}

export function versionFromProbe(stdout: string | undefined, stderr: string | undefined): string | null {
  const out = (stdout ?? "").trim();
  if (out) return out;
  const err = (stderr ?? "").trim().split(/\r\n|\n|\r/, 1)[0]?.trim() ?? "";
  return err || null;
}

export type VersionTriple = readonly [number, number, number];

export function parseVersionTriple(value: string): VersionTriple | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionAtLeast(installed: VersionTriple, floor: VersionTriple): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (installed[i] !== floor[i]) return installed[i] > floor[i];
  }
  return true;
}

export function createAcpDriver(support: AcpSupport): ProviderDriver<AcpConfig> {
  if (support.sessionScopedApproval && !support.configureSession) {
    throw new Error(`${support.displayName}: sessionScopedApproval needs configureSession to apply each turn's mode`);
  }
  const DRIVER_KIND = support.driverKind;
  const SOURCE = support.nativeSource;
  const decodeConfig = decodeAcpConfig(support.defaultCli);
  const DENY_TIMEOUT_NOTE =
    "later.dog: nobody answered this permission request in time. Skip this action and finish what you can without it.";

  return {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: support.displayName,
      supportsMultipleInstances: true,
      access: support.access ?? "subscription",
    },
    install: support.install,
    models: support.models,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),

    async create(input: DriverCreateInput<AcpConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      const childEnv = (activeConfig = config) => {
        const env: Record<string, string | undefined> = {
          ...process.env,
          ...input.environment,
          PATH: augmentedPath(),
        };
        const allowedCredentials = new Set(support.credentialEnv ?? []);
        for (const key of [...PROVIDER_CREDENTIAL_ENV, ...WORKSPACE_CREDENTIAL_ENV]) {
          if (!allowedCredentials.has(key)) delete env[key];
        }
        stripControlPlaneEnv(env);
        support.transformEnv?.(env, activeConfig, instanceId, input.environment);
        return env;
      };
      let models = support.models;
      let accountModels: ReadonlySet<string> | null = null;
      const refreshModels = async () => {
        if (!support.resolveModels) return;
        try {
          const resolved = await support.resolveModels(childEnv(), config, instanceId);
          if (resolved.options.length) {
            models = resolved;
            accountModels = new Set(resolved.options.map((option) => option.id));
          }
        } catch {}
      };
      if (support.resolveModelsOnCreate !== false) await readEngineModels(refreshModels);
      const deviceSignIn = support.deviceSignIn
        ? new DeviceAuthController(support.deviceSignIn, { cli: config.cli, environment: () => childEnv(), onAuthenticated: refreshModels })
        : null;
      const listeners = new Set<RuntimeEventListener>();
      interface Turn {
        stop: () => void;
        interrupt: () => void;
        turnId: string;
        asks: Map<string, AcpAskFinish>;
      }
      const active = new Map<string, Turn>();
      const sessions = new Map<string, AcpSession>();
      const retiring = new Map<string, Set<ReturnType<typeof spawnCli>>>();
      const retireChild = async (threadId: string, child: ReturnType<typeof spawnCli>): Promise<boolean> => {
        let children = retiring.get(threadId);
        if (!children) retiring.set(threadId, children = new Set());
        children.add(child);
        const stopped = await killCliTree(child);
        if (stopped) {
          children.delete(child);
          if (!children.size && retiring.get(threadId) === children) retiring.delete(threadId);
        }
        return stopped;
      };
      const { idleMs: SESSION_IDLE_MS } = sessionIdlePolicy("ACP");

      const closeSession = (threadId: string, why: string) => {
        const session = sessions.get(threadId);
        if (!session || session.closing) return;
        session.closing = true;
        if (session.idleTimer) clearTimeout(session.idleTimer);
        appendNative(threadId, { dir: "out", source: SOURCE, msg: { close: why } });
        sessions.delete(threadId);
        session.acp.close();
        try {
          session.child.stdin.end();
        } catch {}
        if (support.restartOnMcpChange) void retireChild(threadId, session.child);
        else {
          const kill = setTimeout(() => {
            void killCliTree(session.child);
          }, 5_000);
          kill.unref?.();
        }
      };
      const armIdle = (threadId: string) => {
        const session = sessions.get(threadId);
        if (!session) return;
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.idleTimer = setTimeout(() => closeSession(threadId, "idle"), SESSION_IDLE_MS);
        session.idleTimer.unref?.();
      };
      const sessionAllows = new Map<string, Set<string>>();

      const emit = (event: RuntimeEvent) => {
        for (const listener of listeners) listener(event);
      };

      const nativeLogMessage = (msg: any): unknown => {
        let redacted = msg;
        const prompt = msg?.method === "session/prompt" ? msg?.params?.prompt : null;
        if (Array.isArray(prompt)) {
          redacted = {
            ...msg,
            params: {
              ...msg.params,
              prompt: prompt.map((content: any) =>
                content?.type === "image" && typeof content.data === "string"
                  ? { ...content, data: `[image data: ${content.data.length} base64 chars]` }
                  : content
              ),
            },
          };
        }
        const content = redacted?.params?.update?.content;
        if (
          redacted?.method !== "session/update" ||
          redacted?.params?.update?.sessionUpdate !== "agent_message_chunk" ||
          content?.type !== "image" ||
          typeof content.data !== "string"
        ) return support.sanitizeToolPayload ? sanitizeAcpToolMessage(redacted) : redacted;
        redacted = {
          ...redacted,
          params: {
            ...redacted.params,
            update: {
              ...redacted.params.update,
              content: { ...content, data: `[image data: ${content.data.length} base64 chars]` },
            },
          },
        };
        return support.sanitizeToolPayload ? sanitizeAcpToolMessage(redacted) : redacted;
      };
      const base = (threadId: string, turnId: string) => ({
        eventId: newEventId(),
        provider: DRIVER_KIND,
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
      });

      type AcpMcpServer =
        | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
        | { type: "http" | "sse"; name: string; url: string; headers: Array<{ name: string; value: string }> };
      const acpMcpServers = (turn: SendTurnInput) => {
        const servers: AcpMcpServer[] = [];
        const acpEnv = (env: Record<string, string>) =>
          Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
        const agents = turn.integrations?.agents;
        if (agents) {
          servers.push({ name: "agents", command: agents.command, args: agents.args, env: acpEnv(agents.env) });
        }
        const composio = turn.integrations?.composio;
        if (composio) {
          servers.push({
            name: "composio",
            command: composio.command,
            args: composio.args,
            env: acpEnv(composio.env),
          });
        }
        const browser = turn.integrations?.browser;
        if (browser) {
          servers.push({ name: "browser", command: browser.command, args: browser.args, env: acpEnv(browser.env) });
        }
        if (turn.integrations?.localComputer) {
          const local = turn.integrations.localComputer;
          servers.push({
            name: "computer",
            command: local.command,
            args: local.args,
            env: acpEnv(local.env ?? {}),
          });
        }
        for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
          if (servers.some((existing) => existing.name === name)) continue;
          if ("url" in server) {
            servers.push({ type: server.type, name, url: server.url, headers: acpEnv(server.headers) });
            continue;
          }
          servers.push({ name, command: server.command, args: server.args, env: acpEnv(server.env) });
        }
        if (turn.toolScope === undefined) return servers;
        return servers.filter((server) => canUseMcpServer(turn.toolScope, server.name)).map((server) => {
          const original = "url" in server
            ? { type: server.type, url: server.url, headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) }
            : { command: server.command, args: server.args, env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])) };
          const gated = gateServer({ name: server.name, server: original, threadId: turn.threadId, budget: 0,
            toolScope: turn.toolScope, nodeEnv: { ELECTRON_RUN_AS_NODE: "1" } });
          if (!gated) throw new Error("Tool selection requires an MCP gate.");
          return { name: server.name, command: gated.command, args: gated.args, env: acpEnv(gated.env) };
        });
      };

      const startQuietWatch = (threadId: string, session: AcpSession, current: AcpTurn) => {
        const noticeAfterMs = envOr("LATERDOG_ACP_QUIET_NOTICE_MS", 60_000);
        const tickMs = envOr("LATERDOG_ACP_QUIET_TICK_MS", 15_000);
        const logPath = support.statusLog && session.sessionId
          ? support.statusLog.path(session.env, session.sessionId)
          : null;
        const tail = logPath ? new LogTail(logPath) : null;
        tail?.read();
        let logged: { signal: LogSignal; at: number } | null = null;
        let context: { tokens: number; threshold: number } | null = null;
        let previous: ProcessSample | null = null;
        let previousAt = 0;
        let shownKey: string | null = null;
        let noSignsSince: number | null = null;
        let notices = 0;
        let probing = false;
        let state: QuietState | null = null;
        const tick = async () => {
          if (probing || current.state.settled || session.current !== current) return;
          const now = Date.now();
          for (const line of tail?.read() ?? []) {
            session.acp.touch();
            const signal = support.statusLog!.parse(line);
            if (signal?.kind === "context") context = { tokens: signal.tokens, threshold: signal.threshold };
            else if (signal) logged = { signal, at: now };
          }
          const quietMs = now - session.acp.lastInboundAt;
          if (quietMs < noticeAfterMs || current.asks.size || current.runningTools.size) {
            if (quietMs < noticeAfterMs) logged = null;
            previous = null;
            shownKey = null;
            noSignsSince = null;
            state = null;
            return;
          }
          if (logged?.signal.kind === "retry"
              && now - logged.at > (logged.signal.delayMs ?? 60_000) + 120_000) logged = null;
          probing = true;
          const sample = session.child.pid ? await sampleProcessTree(session.child.pid) : { cpuMs: null, connections: null };
          probing = false;
          if (current.state.settled || session.current !== current) return;
          let next = classifyQuiet({
            logged: logged?.signal ?? null, context, sample, previous, sinceMs: previous ? now - previousAt : 0,
          });
          const first = previous === null;
          previous = sample;
          previousAt = now;
          if (first && next.kind === "unknown") return;
          if (next.kind === "no-signs") {
            noSignsSince ??= now;
            if (now - noSignsSince < ACP_STUCK_AFTER_MS) next = { kind: "between-requests" };
          } else {
            noSignsSince = null;
          }
          state = next;
          const key = quietKey(next);
          if (key === shownKey || notices >= 12) return;
          shownKey = key;
          notices += 1;
          emit({
            ...base(threadId, current.turnId),
            type: "runtime.notice",
            message: describeQuiet(support.displayName, next, quietMs, promptIdleTimeoutMs()),
          });
        };
        const timer = setInterval(() => { void tick(); }, tickMs);
        timer.unref?.();
        current.stopQuietWatch = () => clearInterval(timer);
        return { lastState: () => state };
      };

      const settle = (threadId: string, session: AcpSession, ok: boolean, stopReason: string | null) => {
        const current = session.current;
        if (!current || current.state.settled) return;
        current.state.settled = true;
        current.acknowledge();
        current.stopQuietWatch?.();
        if (current.interruptTimer) clearTimeout(current.interruptTimer);
        for (const finish of current.asks.values()) finish("cancel", "system");
        session.acp.failAll(new Error("turn settled"));
        session.current = null;
        active.delete(threadId);
        current.flushAssistantText();
        let finalOk = ok;
        let finalStopReason = stopReason;
        if (finalOk && finalStopReason === null && !current.state.producedItem) {
          finalOk = false;
          finalStopReason = "empty_turn";
          emit({
            ...base(threadId, current.turnId),
            type: "runtime.error",
            message: `${DRIVER_KIND} ended the turn with no reply, image, or tool result`,
          });
        }
        emit({ ...base(threadId, current.turnId), type: "turn.completed", ok: finalOk, stopReason: finalStopReason, cost: null });
        if (session.child.exitCode === null && !session.closing && !session.dead) {
          armIdle(threadId);
        } else if (session.dead && sessions.get(threadId) === session) {
          sessions.delete(threadId);
        }
      };

      const openSession = (
        threadId: string,
        launch: { command: string; args?: string[] },
        argv: string[],
        env: Record<string, string | undefined>,
        cwd: string,
        contractKey: string,
      ): AcpSession => {
        const commandCwd = permissionLaunchCwd(cwd);
        const child = spawnCli(launch.command, argv, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let nextId = 1;
        const privateResponses = new Set<number>();
        const rpcPending = new Map<
          number,
          {
            method: string;
            resolve: (v: any) => void;
            reject: (e: Error) => void;
            timer: ReturnType<typeof setTimeout> | null;
            idleTimer: ReturnType<typeof setTimeout> | null;
            armIdle: () => void;
          }
        >();

        const send = (obj: unknown) => {
          const message = obj as { id?: unknown; result?: unknown; error?: unknown };
          if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
            for (const pending of rpcPending.values()) pending.armIdle();
          }
          try {
            child.stdin.write(JSON.stringify(obj) + "\n");
          } catch {}
          appendNative(threadId, { dir: "out", source: SOURCE, msg: nativeLogMessage(obj) });
        };
        const request = (
          method: string,
          params: unknown,
          timeoutMs?: number,
          receive?: (result: any) => void,
          idleMs?: number,
          idleMessage?: string | (() => string),
        ) =>
          new Promise<any>((resolve, reject) => {
            const id = nextId++;
            if (method === "_x.ai/mcp/list") privateResponses.add(id);
            let timer: ReturnType<typeof setTimeout> | null = null;
            if (timeoutMs) {
              timer = setTimeout(() => {
                rpcPending.delete(id);
                reject(Object.assign(new Error(`${method} timed out`), { acpSessionFailure: true }));
              }, timeoutMs);
              timer.unref?.();
            }
            let idleTimer: ReturnType<typeof setTimeout> | null = null;
            const armIdle = () => {
              if (!(idleMs && idleMs > 0)) return;
              if (idleTimer) clearTimeout(idleTimer);
              idleTimer = setTimeout(() => {
                if (session.current?.asks.size || session.current?.runningTools.size) { armIdle(); return; }
                rpcPending.delete(id);
                const error = new Error((typeof idleMessage === "function" ? idleMessage() : idleMessage) ?? `${method} stopped responding`);
                Object.assign(error, { acpPromptStall: true });
                reject(error);
              }, idleMs);
              idleTimer.unref?.();
            };
            armIdle();
            rpcPending.set(id, {
              method,
              resolve: (result) => { receive?.(result); resolve(result); },
              reject,
              timer,
              get idleTimer() { return idleTimer; },
              armIdle,
            });
            send({ jsonrpc: "2.0", id, method, params });
          });
        let lastInboundAt = Date.now();
        const acp: AcpConnection = {
          send,
          request,
          get lastInboundAt() { return lastInboundAt; },
          touch: () => { for (const p of rpcPending.values()) p.armIdle(); },
          failAll: (error: Error) => {
            for (const p of rpcPending.values()) {
              if (p.timer) clearTimeout(p.timer);
              if (p.idleTimer) clearTimeout(p.idleTimer);
              p.reject(error);
            }
            rpcPending.clear();
          },
          close: () => {
            acp.failAll(new Error("session closed"));
            child.stdout.removeAllListeners("data");
          },
        };

        const resolveClientPath = async (requestPath: unknown): Promise<string> => {
          if (typeof requestPath !== "string" || !isAbsolute(requestPath)) {
            throw new Error("ACP file paths must be absolute.");
          }
          const workspace = await realpath(cwd).catch(() => resolve(cwd));
          const requested = resolve(requestPath);
          const lexical = relative(resolve(cwd), requested);
          if (lexical === ".." || lexical.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(lexical)) {
            throw new Error("ACP file path is outside the session workspace.");
          }
          const suffix = [basename(requested)];
          let ancestor = dirname(requested);
          while (!(await lstat(ancestor).catch(() => null))) {
            const parent = dirname(ancestor);
            if (parent === ancestor) throw new Error("ACP file path has no accessible parent.");
            suffix.unshift(basename(ancestor));
            ancestor = parent;
          }
          const candidate = resolve(await realpath(ancestor), ...suffix);
          const rel = relative(workspace, candidate);
          if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
            throw new Error("ACP file path is outside the session workspace.");
          }
          const existing = await lstat(candidate).catch(() => null);
          if (existing?.isSymbolicLink()) throw new Error("ACP file path cannot be a symbolic link.");
          return candidate;
        };

        const handleClientFileRequest = async (msg: any): Promise<void> => {
          const fail = (error: unknown) => send({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32602, message: error instanceof Error ? error.message : String(error) },
          });
          try {
            if (!support.clientFileSystem) throw new Error("Client file access is disabled.");
            const params = msg.params ?? {};
            const path = await resolveClientPath(params.path);
            if (msg.method === "fs/read_text_file") {
              const info = await stat(path);
              if (!info.isFile() || info.size > CLIENT_FILE_MAX_BYTES) {
                throw new Error(`ACP can only read text files under ${CLIENT_FILE_MAX_BYTES} bytes.`);
              }
              const content = await readFile(path, "utf8");
              if (params.line == null && params.limit == null) {
                send({ jsonrpc: "2.0", id: msg.id, result: { content } });
                return;
              }
              const line = typeof params.line === "number" && Number.isInteger(params.line) && params.line > 0 ? params.line : 1;
              const limit = typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit >= 0 ? params.limit : undefined;
              const lines = content.split("\n");
              const start = line - 1;
              send({
                jsonrpc: "2.0",
                id: msg.id,
                result: { content: lines.slice(start, limit === undefined ? undefined : start + limit).join("\n") },
              });
              return;
            }
            if (typeof params.content !== "string" || Buffer.byteLength(params.content) > CLIENT_FILE_MAX_BYTES) {
              throw new Error(`ACP can only write text files under ${CLIENT_FILE_MAX_BYTES} bytes.`);
            }
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, params.content, "utf8");
            send({ jsonrpc: "2.0", id: msg.id, result: {} });
          } catch (error) {
            fail(error);
          }
        };

        const handleServerRequest = (msg: any, current: AcpTurn) => {
          current.state.startupActivity = true;
          if (msg.method === "fs/read_text_file" || msg.method === "fs/write_text_file") {
            void handleClientFileRequest(msg);
            return;
          }
          if (msg.method !== "session/request_permission") {
            return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
          }
          const params = msg.params ?? {};
          current.flushAssistantText();
          const options: Array<{ optionId?: string; kind?: string; name?: string }> = Array.isArray(params.options) ? params.options : [];
          const optionFor = (want: "allow" | "reject") =>
            options.find((o) => o.kind === `${want}_once` && typeof o.optionId === "string")?.optionId
              ?? options.find((o) => String(o.kind ?? "").startsWith(want) && typeof o.optionId === "string")?.optionId
              ?? null;
          const optionAlways = options.find((o) => o.kind === "allow_always" && typeof o.optionId === "string")?.optionId ?? null;
          const cancelled = { outcome: { outcome: "cancelled" } };
          const missing = (want: string) =>
            emit({
              ...base(threadId, current.turnId),
              type: "runtime.error",
              message: `${DRIVER_KIND} offered no "${want}" permission option — cancelling the request instead of guessing`,
            });

          const toolCall = params.toolCall ?? {};
          const isQuestion = String(toolCall.toolCallId ?? "").startsWith("interaction_");
          if (current.turnConfig.fullAuto && current.turn.approvalMode === undefined && !isQuestion) {
            const allow = optionFor("allow");
            if (!allow) missing("allow");
            return send({
              jsonrpc: "2.0",
              id: msg.id,
              result: allow ? { outcome: { outcome: "selected", optionId: allow } } : cancelled,
            });
          }
          const kind = String(toolCall.kind ?? "");
          const operationKey = isQuestion || current.controlsHost ? null : sessionOperationKey(toolCall);
          if (operationKey && sessionAllows.get(threadId)?.has(operationKey)) {
            const allow = optionFor("allow");
            if (allow) {
              return send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: allow } } });
            }
          }
          const tool = kind === "execute" ? "shell" : kind === "edit" ? "edit" : kind || "tool";
          const isShellCommand = !isQuestion && kind === "execute" && !/^mcp(?:__|[.:])/i.test(String(toolCall.title ?? ""));
          const rawSummary = String(toolCall.rawInput?.command ?? toolCall.title ?? tool);
          const summary = rawSummary.slice(0, isQuestion ? MAX_QUESTION_TEXT : 200);
          const questionChoices = isQuestion
            ? options.flatMap((option) => typeof option.name === "string" && option.name.trim() ? [option.name.trim()] : [])
            : [];
          const askQuestions = isQuestion && questionChoices.length
            ? parseAskQuestions({ questions: [{ question: summary, options: questionChoices }] }) ?? undefined
            : undefined;
          const requestId = newId();
          const finish = (
            behavior: string,
            source: "user" | "timeout" | "system" = "user",
            message?: string,
            always?: boolean,
          ): RequestOutcome => {
            if (!current.asks.delete(requestId)) return "unavailable";
            clearTimeout(timer);
            const want = behavior === "allow" ? "allow" : "reject";
            const forSession = want === "allow" && always === true && !isQuestion && !current.controlsHost;
            const picked = askQuestions
              ? questionAnswersByQuestion(message ?? "", askQuestions)[askQuestions[0]!.question] ?? message
              : message;
            const named = isQuestion && behavior === "answer"
              ? options.filter((option) => option.optionId === picked || parseChoices([option.name], 1)?.[0] === picked)
              : [];
            const optionId = behavior === "cancel"
              ? null
              : isQuestion
                ? named.length === 1 && typeof named[0].optionId === "string" ? named[0].optionId : null
                : forSession
                  ? optionAlways ?? optionFor("allow")
                  : optionFor(want);
            if (forSession && !optionAlways && optionId && operationKey) {
              const remembered = sessionAllows.get(threadId) ?? new Set<string>();
              remembered.add(operationKey);
              sessionAllows.set(threadId, remembered);
            }
            if (behavior !== "cancel" && !optionId) missing(isQuestion ? "matching answer" : want);
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: optionId ? { outcome: { outcome: "selected", optionId } } : cancelled,
            });
            emit({
              ...base(threadId, current.turnId),
              type: "request.resolved",
              requestId,
              behavior: optionId && isQuestion ? "answer" : optionId && behavior === "allow" ? "allow" : "deny",
              source: optionId ? source : "system",
              approvalScope: current.controlsHost ? "local-computer" : undefined,
            });
            return !optionId ? "rejected" : isQuestion ? "answered" : behavior === "allow" ? "allowed-once" : "rejected";
          };
          const timer = setTimeout(() => {
            emit({ ...base(threadId, current.turnId), type: "runtime.error", message: DENY_TIMEOUT_NOTE });
            finish("deny", "timeout");
          }, 15 * 60_000);
          timer.unref?.();
          current.asks.set(requestId, finish);
          emit({
            ...base(threadId, current.turnId),
            type: "request.opened",
            requestId,
            requestType: isQuestion ? "question" : "permission",
            tool,
            summary,
            command: isShellCommand ? acpPermissionCommand(toolCall.rawInput, commandCwd) : undefined,
            requiresExplicitApproval: isShellCommand && (
              toolCall.rawInput?.dangerouslyDisableSandbox === true || toolCall.rawInput?.sandbox_permissions === "require_escalated"
            ) || undefined,
            choices: askQuestions?.[0]?.options.map(option => option.label) ?? (isQuestion ? questionChoices : undefined),
            ...(askQuestions ? { questions: askQuestions } : {}),
            approvalScope: current.controlsHost ? "local-computer" : undefined,
            allowSession: !isQuestion && !current.controlsHost ? true : undefined,
          });
        };

        const handleNotification = (msg: any) => {
          if (msg.method !== "session/update") return;
          const p = msg.params ?? {};
          if (p._meta?.isReplay === true) return;
          const current = session.current;
          if (support.modelVariants && p.update?.sessionUpdate === "config_option_update") {
            if (current && !current.state.settled && session.sessionId && p.sessionId === session.sessionId) current.receiveModelVariants(p.update);
            return;
          }
          if (current && ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(p.update?.sessionUpdate)) {
            current.state.startupActivity = true;
          }
          if (!current || !current.state.promptSent) return;
          const u = p.update ?? {};
          switch (u.sessionUpdate) {
            case "agent_message_chunk": {
              const content = u.content;
              const delta = content?.text;
              if (content?.type === "image" && typeof content.data === "string" && content.data) {
                current.flushAssistantText();
                current.state.producedItem = true;
                emit({
                  ...base(threadId, current.turnId),
                  type: "item.completed",
                  itemType: "assistant_image",
                  data: content.data,
                  alt: "Generated image",
                });
              } else if (typeof delta === "string" && delta) {
                current.state.text += delta;
                emit({ ...base(threadId, current.turnId), type: "content.delta", streamKind: "assistant_text", delta });
              }
              break;
            }
            case "agent_thought_chunk": {
              const delta = u.content?.text;
              if (typeof delta === "string" && delta) {
                emit({ ...base(threadId, current.turnId), type: "content.delta", streamKind: "reasoning_text", delta });
              }
              break;
            }
            case "tool_call": {
              current.flushAssistantText();
              trackRunningTool(current, u, "pending");
              emit({
                ...base(threadId, current.turnId),
                type: "item.started",
                itemType: "tool",
                itemId: (typeof u.toolCallId === "string" && u.toolCallId) ? u.toolCallId : nextUnkeyedToolId(current),
                title: String(u.rawInput?.command ?? u.title ?? "tool").slice(0, 80),
                summary: commandSummary(u.rawInput),
                input: toolDetailPreview(u.rawInput),
              });
              break;
            }
            case "tool_call_update": {
              trackRunningTool(current, u);
              if (u.status === "completed" || u.status === "failed") {
                current.state.producedItem = true;
                const toolItemId = (typeof u.toolCallId === "string" && u.toolCallId) ? u.toolCallId : current.unkeyedToolIds.shift();
                emit({
                  ...base(threadId, current.turnId),
                  type: "item.completed",
                  itemType: "tool",
                  itemId: toolItemId,
                  ok: u.status !== "failed",
                  output: toolDetailPreview(u.rawOutput ?? u.content),
                });
                for (const img of extractMcpImages(u.content ?? u.rawOutput)) {
                  emit({ ...base(threadId, current.turnId), type: "item.completed", itemType: "assistant_image", itemId: toolItemId, data: img.data });
                }
              }
              break;
            }
            case "usage_update": {
              const used = u.used ?? u.usage?.used;
              if (typeof used !== "number" || !(used > 0)) break;
              if (current.state.usagePeak !== null && used < current.state.usagePeak * ACP_COMPACTION_COLLAPSE_RATIO) {
                current.state.usageCompacted = true;
              }
              if (current.state.usagePeak === null || used > current.state.usagePeak) current.state.usagePeak = used;
              current.state.usageLast = used;
              break;
            }
          }
        };

        const session: AcpSession = {
          child,
          acp,
          launch,
          env,
          cwd,
          contractKey,
          sessionKey: null,
          sessionId: null,
          sessionConfigResult: null,
          initResult: null,
          authenticated: false,
          idleTimer: null,
          closing: false,
          dead: false,
          stderr: "",
          current: null,
        };
        let buf = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            let msg: any;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            appendNative(threadId, { dir: "in", source: SOURCE, msg: nativeLogMessage(acpNativeIncomingLogMessage(msg, privateResponses)) });
            lastInboundAt = Date.now();
            for (const p of rpcPending.values()) p.armIdle();
            if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
              const pend = rpcPending.get(msg.id);
              if (pend) {
                rpcPending.delete(msg.id);
                if (pend.timer) clearTimeout(pend.timer);
                if (pend.idleTimer) clearTimeout(pend.idleTimer);
                if (msg.error) {
                  pend.reject(acpRpcError(msg.error, pend.method));
                } else {
                  pend.resolve(msg.result);
                }
              }
            } else if (msg.id !== undefined && msg.method) {
              const current = session.current;
              if (!current) {
                send(msg.method === "session/request_permission"
                  ? { jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }
                  : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
              } else {
                handleServerRequest(msg, current);
              }
            } else if (msg.method) {
              handleNotification(msg);
            }
          }
        });

        child.stderr.on("data", (c) => {
          if (!support.redactStderr) session.stderr += c;
          if (session.stderr.length > 8192) session.stderr = session.stderr.slice(-8192);
        });
        child.on("error", (e) => {
          session.dead = true;
          const current = session.current;
          if (!current) return;
          emit({ ...base(threadId, current.turnId), type: "runtime.error", ...describeSpawnFailure(e, launch.command) });
          settle(threadId, session, false, "spawn_error");
        });
        child.on("close", (code) => {
          session.dead = true;
          const current = session.current;
          if (current) {
            emit({
              ...base(threadId, current.turnId),
              type: "runtime.error",
              message: `${DRIVER_KIND} exited ${code} before the prompt result${session.stderr ? `: ${session.stderr.trim().slice(-300)}` : ""}`,
            });
            settle(threadId, session, false, "exit_before_result");
          } else if (sessions.get(threadId) === session) {
            sessions.delete(threadId);
          }
        });
        return session;
      };

      const sendTurn = async (turn: SendTurnInput) => {
        const parsedScope = parseToolScope(turn.toolScope);
        if (!parsedScope.ok) throw new Error(parsedScope.error);
        turn = { ...turn, toolScope: parsedScope.scope };
        if (narrowsNativeTools(turn.toolScope) && !support.toolScopeSessionParams) {
          throw new Error(`${support.displayName}: native tool selection is not supported by this engine. Keep native:* in the selection or choose a supported engine.`);
        }
        const { threadId } = turn;
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        const turnConfig = turn.approvalMode === undefined
          ? config
          : { ...config, fullAuto: turn.approvalMode === "full" && supportsApprovalMode(DRIVER_KIND, "full") };
        const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
        if (controlsHost && turnConfig.fullAuto && turn.approvalMode !== "full") {
          throw new Error("local computer control requires interactive provider approvals");
        }
        const turnId = newId();
        const cwd = turn.cwd ?? turnConfig.workspace ?? homedir();
        const env = childEnv(turnConfig);
        if (
          support.requireAuthenticationBeforeSpawn
          && !skipSubscriptionAuthForLocalInject(turn.model)
          && !(await support.isAuthenticated(env, turnConfig, instanceId))
        ) {
          emit({ ...base(threadId, turnId), type: "turn.started" });
          emit({ ...base(threadId, turnId), type: "runtime.error", message: support.loginNote, setup: true });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "auth_required", cost: null });
          return { turnId };
        }
        const resolvedModel = support.resolveTurnModel?.(turn.model, env);
        support.applyTurnEnv?.(env, {
          model: resolvedModel, requestedModel: turn.model, fullAuto: turnConfig.fullAuto === true, botId: turn.botId, cwd, toolScope: turn.toolScope,
        });
        let cliTurn =
          resolvedModel !== undefined && resolvedModel !== turn.model
            ? { ...turn, model: resolvedModel }
            : turn;
        const mcpServers = acpMcpServers(turn);
        let launch: { command: string; args?: string[]; env?: Record<string, string | undefined> };
        try {
          launch = support.resolveCommand
            ? await support.resolveCommand(env, turnConfig, instanceId)
            : { command: turnConfig.cli };
        } catch (error) {
          emit({ ...base(threadId, turnId), type: "turn.started" });
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: error instanceof Error ? error.message : String(error),
            setup: true,
          });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "setup_required", cost: null });
          return { turnId };
        }

        const spawnArgs = support.spawnArgs(turnConfig, cliTurn);
        const spawnEnv = launch.env ?? env;
        const envFingerprint = createHash("sha256").update(JSON.stringify(spawnEnv)).digest("hex").slice(0, 16);
        const inheritedScopeFingerprint = narrowsNativeTools(turn.toolScope) && support.toolScopeCacheKey
          ? createHash("sha256").update(support.toolScopeCacheKey({ config: turnConfig, env, cwd })).digest("hex") : null;
        const contractKey = JSON.stringify([
          launch.command, launch.args ?? [], spawnArgs, cwd,
          support.sessionScopedApproval ? null : turnConfig.fullAuto === true, envFingerprint,
          support.spawnFingerprint?.(spawnEnv) ?? null,
          turn.toolScope ?? null,
          inheritedScopeFingerprint,
        ]);
        const launchModel = support.sessionModelEnv && cliTurn.model && /^[\w.:/-]{1,200}$/u.test(cliTurn.model)
          && accountModels?.has(cliTurn.model) ? cliTurn.model : undefined;
        const launchEnv = support.sessionModelEnv && launchModel
          ? { ...spawnEnv, [support.sessionModelEnv]: launchModel }
          : spawnEnv;
        let launchedThisTurn = false;
        const launchSession = () => {
          const opened = openSession(threadId, launch, [...(launch.args ?? []), ...spawnArgs], launchEnv, cwd, contractKey);
          opened.launchModel = launchModel;
          launchedThisTurn = true;
          return opened;
        };
        const sessionKey = JSON.stringify([mcpServers, turn.toolScope ?? null, inheritedScopeFingerprint]);

        if (turn.sessionReset) {
          closeSession(threadId, "reset");
          sessionAllows.delete(threadId);
        }
        const pooled = sessions.get(threadId);
        let session: AcpSession;
        if (pooled && !pooled.dead && !pooled.closing && pooled.contractKey === contractKey
            && (!support.restartOnMcpChange || pooled.sessionKey === sessionKey)) {
          if (pooled.idleTimer) clearTimeout(pooled.idleTimer);
          pooled.idleTimer = null;
          session = pooled;
        } else {
          if (pooled) {
            if (pooled.dead) sessions.delete(threadId);
            else closeSession(threadId, "contract");
          }
          session = launchSession();
          sessions.set(threadId, session);
        }
        const request = (
          method: string,
          params: unknown,
          timeoutMs?: number,
          receive?: (result: any) => void,
          idleMs?: number,
          idleMessage?: string | (() => string),
        ): Promise<any> =>
          session.acp.request(method, params, timeoutMs, receive, idleMs, idleMessage);

        const state: AcpTurn["state"] = { settled: false, promptSent: false, text: "", producedItem: false, startupActivity: false, stopped: false, usagePeak: null, usageLast: null, usageCompacted: false };
        let acknowledge = () => {};
        let rejectStartup = (_error: TurnNotStartedError) => {};
        const startupAck = turn.startupRecovery ? new Promise<{ turnId: string }>((resolve, reject) => {
          acknowledge = () => resolve({ turnId });
          rejectStartup = reject;
        }) : null;
        const asks = new Map<string, AcpAskFinish>();
        let reportedModel = turn.model;
        let variant = turn.variant;
        let staleProcess = false;
        let approvalUnconfirmed = false;
        const modelOf = (result: any): string | null => {
          const option = (Array.isArray(result?.configOptions) ? result.configOptions : []).find(
            (entry: any) => entry?.id === (support.selectModel?.configId ?? "model"),
          );
          return typeof option?.currentValue === "string" ? option.currentValue : null;
        };
        const receiveModelVariants = (result: any) => {
          session.sessionConfigResult = result;
          if (!support.modelVariants) return;
          const nativeModel = modelOf(result) ?? cliTurn.model;
          if (!nativeModel) return;
          const option = acpVariantOption(result);
          emit({
            ...base(threadId, turnId),
            type: "session.model-variants",
            model: nativeModel === cliTurn.model ? (reportedModel ?? nativeModel) : nativeModel,
            variants: {
              options: option?.options ?? [],
              ...(option?.currentValue !== undefined ? { currentValue: option.currentValue } : {}),
            },
          });
        };
        const requestedVariantOption = () => {
          if (!support.modelVariants) throw new Error(`${support.displayName} does not support model variants`);
          const option = acpVariantOption(session.sessionConfigResult);
          if (!option || !option.options.some((entry) => entry.id === variant)) {
            throw new Error(`${support.displayName} does not advertise variant ${variant} for this model`);
          }
          return option;
        };

        const flushAssistantText = () => {
          const text = state.text;
          state.text = "";
          if (!text.trim()) return;
          state.producedItem = true;
          emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
        };
        const current: AcpTurn = {
          turnId,
          turn: cliTurn,
          turnConfig,
          controlsHost,
          state,
          acknowledge,
          asks,
          runningTools: new Set(),
          unkeyedToolIds: [],
          interruptTimer: null,
          stopQuietWatch: null,
          flushAssistantText,
          receiveModelVariants,
        };

        const interrupt = () => {
          state.stopped = true;
          if (session.sessionId) {
            session.acp.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: session.sessionId } });
            if (current.interruptTimer) clearTimeout(current.interruptTimer);
            current.interruptTimer = setTimeout(() => {
              closeSession(threadId, "cancel-timeout");
              settle(threadId, session, true, "cancelled");
            }, 5_000);
            current.interruptTimer.unref?.();
          } else {
            closeSession(threadId, "stop");
          }
        };
        active.set(threadId, { stop: () => { state.stopped = true; closeSession(threadId, "stop"); }, interrupt, turnId, asks });
        emit({ ...base(threadId, turnId), type: "turn.started" });
        session.current = current;

        (async () => {
          let pendingSplitReceipt: { key: string; receipt: PromptSplitReceipt; previous: PromptSplitReceipt | null } | null = null;
          try {
            const handshake = async (): Promise<boolean> => {
              for (const child of retiring.get(threadId) ?? []) {
                const stopped = await retireChild(threadId, child);
                if (state.settled || session.closing) throw new Error("session closed");
                if (!stopped) {
                  closeSession(threadId, "replace-failed");
                  throw new Error(`${support.displayName} could not close its previous tool session. Try again.`);
                }
              }
              if (state.settled || session.closing) throw new Error("session closed");
              if (!session.initResult) {
                session.initResult = await request(
                  "initialize",
                  {
                    protocolVersion: 1,
                    clientInfo: { name: "laterdog", version: "0.0.0" },
                    clientCapabilities: {
                      fs: {
                        readTextFile: support.clientFileSystem === true,
                        writeTextFile: support.clientFileSystem === true,
                      },
                      terminal: false,
                    },
                  },
                  INIT_TIMEOUT,
                );
              }
              if (!skipSubscriptionAuthForLocalInject(turn.model) && !session.authenticated) {
                const methods: Array<{ id?: string }> = Array.isArray(session.initResult?.authMethods)
                  ? session.initResult.authMethods
                  : [];
                const methodId = support.pickAuthMethod(methods);
                if (methodId) {
                  try {
                    await request("authenticate", { methodId }, INIT_TIMEOUT);
                    session.authenticated = true;
                  } catch {
                    if (support.authFailure === "fail") throw new Error(support.loginNote);
                  }
                } else if (support.authFailure === "fail") {
                  throw new Error(support.loginNote);
                }
              }
              const images = turn.images ?? [];
              const accepts = session.initResult?.agentCapabilities?.promptCapabilities?.image === true ||
                support.acceptsUnadvertisedImages?.(session.initResult) === true;
              if (images.length && support.images === true && !accepts) {
                throw new Error(
                  `${support.displayName} is configured for image attachments, but this installed runtime does not advertise ACP image input. Update the ${support.displayName} CLI or send the message without an image.`,
                );
              }
              return accepts;
            };
            let runtimeAcceptsImages = await handshake();
            let init = session.initResult;

            const cursor = !turn.sessionReset && typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
            let sessionResult: any = null;
            let promptTurn = turn;
            let rebuiltFromReplay = false;
            for (;;) {
              const liveSessionId = session.sessionId;
              if (liveSessionId !== null && session.sessionKey === sessionKey && (cursor === null || cursor === liveSessionId)) {
                break;
              }
              const sessionServers = mcpServers.filter((server) =>
                !("type" in server) || init?.agentCapabilities?.mcpCapabilities?.[server.type] === true);
              const selectionParams = narrowsNativeTools(turn.toolScope)
                ? support.toolScopeSessionParams!(turn, init, sessionServers.length > 0, { config: turnConfig, env, cwd }) : {};
              let loaded = false;
              if (cursor) {
                try {
                  await request(
                    support.resumeMethod === "resume" ? "session/resume" : "session/load",
                    { sessionId: cursor, cwd, mcpServers: sessionServers, ...selectionParams },
                    LOAD_SESSION_TIMEOUT,
                    (result) => {
                      if (result) {
                        loaded = true;
                        session.sessionId = cursor;
                        session.sessionKey = sessionKey;
                        receiveModelVariants(result);
                      }
                    },
                  );
                } catch (error) {
                  const classification = support.classifyError?.(error);
                  const data = (error as any)?.data;
                  const missingSession = data && typeof data === "object" && !Array.isArray(data)
                    && data.sessionId === cursor && Object.keys(data).length === 1;
                  if (classification === "invalid_credentials" || classification === "inactive_subscription"
                      || ((error as any)?.code === -32602 && !missingSession)) throw error;
                }
              }
              if (loaded) break;
              if (cursor && liveSessionId === cursor) {
                session.current = null;
                closeSession(threadId, "reestablish");
                session = launchSession();
                sessions.set(threadId, session);
                session.current = current;
                runtimeAcceptsImages = await handshake();
                init = session.initResult;
                continue;
              }
              sessionAllows.delete(threadId);
              if (cursor) {
                const recovery = recoveryPromptFor({
                  recoveryText: turn.recoveryText,
                  currentText: turn.text,
                  failure: "before-accept",
                });
                promptTurn = { ...turn, text: recovery.text };
                rebuiltFromReplay = recovery.replayed;
              }
              sessionResult = await request("session/new", { cwd, mcpServers: sessionServers, ...selectionParams }, NEW_SESSION_TIMEOUT, (result) => {
                session.sessionId = typeof result?.sessionId === "string" ? result.sessionId : null;
                session.sessionKey = sessionKey;
                receiveModelVariants(result);
              });
              break;
            }
            const sessionId = session.sessionId;
            if (sessionId === null) throw new Error("session/new returned no sessionId");
            let selectedModel: string | null = null;
            let sessionStarted = false;
            const emitSessionStarted = () => {
              if (sessionStarted) return;
              sessionStarted = true;
              emit({
                ...base(threadId, turnId),
                type: "session.started",
                sessionId,
                model: selectedModel ?? init?._meta?.modelState?.currentModelId ?? cliTurn.model ?? null,
                ...(rebuiltFromReplay ? { rebuilt: true } : {}),
              });
            };

            try {
              if (support.selectModel) {
                const { configId } = support.selectModel;
                selectedModel = modelOf(session.sessionConfigResult);
                const wanted = cliTurn.model;
                const offered = offeredModels(session.sessionConfigResult, configId);
                if (support.sessionModelEnv && !session.launchModel && offered.length) accountModels = new Set(offered);
                staleProcess = Boolean(support.fallbackModel && wanted && !launchedThisTurn && offered.length
                  && !offered.includes(wanted) && models.options.some((option) => option.id === wanted));
                if (support.fallbackModel && offered.length && !skipSubscriptionAuthForLocalInject(turn.model)
                    && !staleProcess && (!wanted || !offered.includes(wanted))) {
                  const fallback = support.fallbackModel(session.sessionConfigResult, models.default);
                  if (fallback && fallback !== wanted && offered.includes(fallback)) {
                    const notice = wanted ? `${wanted}\n${fallback}` : null;
                    if (notice && session.fallbackNotice !== notice) {
                      session.fallbackNotice = notice;
                      emit({
                        ...base(threadId, turnId),
                        type: "runtime.notice",
                        message: `${support.displayName} no longer offers ${wanted}, so this conversation uses ${fallback}. ` +
                          "Choose another model for this dog to stop seeing this.",
                      });
                    }
                    cliTurn = { ...cliTurn, model: fallback };
                    current.turn = cliTurn;
                    reportedModel = fallback;
                    variant = undefined;
                  }
                }
                if (cliTurn.model && cliTurn.model !== selectedModel) {
                  sessionResult = await request(
                    "session/set_config_option",
                    { sessionId, configId, value: cliTurn.model },
                    INIT_TIMEOUT,
                    receiveModelVariants,
                  );
                  selectedModel = modelOf(session.sessionConfigResult);
                  if (selectedModel !== cliTurn.model) {
                    throw new Error(
                      `${DRIVER_KIND} did not switch to ${cliTurn.model} (still ${selectedModel ?? "unknown"})`,
                    );
                  }
                }
              }

              if (support.configureSession) {
                approvalUnconfirmed = support.sessionScopedApproval === true;
                await support.configureSession({
                  request: (method, params, timeoutMs) =>
                    request(method, params, timeoutMs ?? SESSION_CONFIG_TIMEOUT),
                  sessionId,
                  config: turnConfig,
                  turn: cliTurn,
                  sessionModels: Array.isArray(sessionResult?.models?.availableModels)
                    ? sessionResult.models.availableModels
                    : [],
                  currentModelId: session.sessionConfigResult?.models?.currentModelId,
                });
                approvalUnconfirmed = false;
                if (!selectedModel && cliTurn.model) selectedModel = cliTurn.model;
              }
              if (variant !== undefined) {
                const option = requestedVariantOption();
                await request(
                  "session/set_config_option",
                  { sessionId, configId: option.configId, value: variant },
                  SESSION_CONFIG_TIMEOUT,
                  receiveModelVariants,
                );
                if (requestedVariantOption().currentValue !== variant) {
                  throw new Error(`${support.displayName} did not apply variant ${variant}`);
                }
              }
            } catch (error) {
              emitSessionStarted();
              throw error;
            }
            emitSessionStarted();
            const halves = promptHalves(turn);
            let promptInput = promptTurn;
            if (halves.stable !== null) {
              const receiptKey = JSON.stringify([threadId, sessionId]);
              const previousReceipt = readPromptSplitReceipt(DRIVER_KIND, receiptKey);
              state.usagePeak = previousReceipt?.peakUsed ?? previousReceipt?.lastUsed ?? null;
              const composed = splitSessionPrompt(
                halves.stable,
                halves.volatile,
                previousReceipt,
                promptTurn.system,
                promptTurn.text,
                Boolean(turn.mentionTurn),
                ACP_PROMPT_RE_ANCHOR_TURNS,
              );
              promptInput = { ...promptTurn, system: "", text: composed.text };
              pendingSplitReceipt = { key: receiptKey, receipt: composed.receipt, previous: previousReceipt };
            }
            const text = support.buildPromptText
              ? support.buildPromptText(promptInput)
              : promptInput.system
                ? `${promptInput.system}\n\n${promptInput.text}`
                : promptInput.text;
            const imageBlocks = support.images === true && runtimeAcceptsImages
              ? await readAcpImageBlocks(turn.images ?? [])
              : [];
            if (support.modelVariants && cliTurn.model && modelOf(session.sessionConfigResult) !== cliTurn.model) {
              throw new Error(`${support.displayName} changed model before the prompt`);
            }
            if (variant !== undefined && requestedVariantOption().currentValue !== variant) {
              throw new Error(`${support.displayName} changed variant before the prompt`);
            }
            if (state.settled || state.stopped || session.closing) throw new Error("turn stopped");
            state.promptSent = true;
            acknowledge();
            const promptIdleMs = promptIdleTimeoutMs();
            const quiet = startQuietWatch(threadId, session, current);
            const result = await request(
              "session/prompt",
              { sessionId, prompt: [{ type: "text", text }, ...imageBlocks] },
              undefined,
              undefined,
              promptIdleMs,
              () => {
                const last = quiet.lastState();
                return `${DRIVER_KIND} sent nothing for ${formatQuietLimit(promptIdleMs)} with no tool running, so the turn was stopped as stuck` +
                  `${last ? ` (last seen: ${lastSeenPhrase(last)})` : ""}. ` +
                  "Send the message again to retry. On a self-hosted server, LATERDOG_ACP_PROMPT_IDLE_TIMEOUT_MS sets this limit (0 turns it off).";
              },
              );
            if (pendingSplitReceipt) {
              if (state.usageCompacted) {
                deletePromptSplitReceipt(DRIVER_KIND, pendingSplitReceipt.key);
              } else {
                const previousLastUsed = typeof pendingSplitReceipt.previous?.lastUsed === "number"
                  ? pendingSplitReceipt.previous.lastUsed
                  : undefined;
                const lastUsed = state.usageLast ?? previousLastUsed;
                writePromptSplitReceipt(
                  DRIVER_KIND,
                  pendingSplitReceipt.key,
                  {
                    ...pendingSplitReceipt.receipt,
                    ...(lastUsed === undefined ? {} : { lastUsed }),
                    ...(state.usagePeak === null ? {} : { peakUsed: state.usagePeak }),
                  },
                );
              }
            }
            const usage = result?.usage ?? result?._meta ?? {};
            if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") {
              const input = usage.inputTokens ?? 0;
              const output = usage.outputTokens ?? 0;
              const cachedRead = typeof usage.cachedReadTokens === "number" && usage.cachedReadTokens > 0
                ? usage.cachedReadTokens
                : null;
              const exclusive = cachedRead !== null
                && (typeof usage.totalTokens !== "number"
                  || usage.totalTokens >= input + output + cachedRead);
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: cachedRead !== null && exclusive ? input + cachedRead : input,
                output,
                ...(cachedRead !== null
                  ? { cachedInput: exclusive ? cachedRead : Math.min(cachedRead, input) }
                  : {}),
              });
            }
            const reason = result?.stopReason;
            if (reason === "end_turn") settle(threadId, session, true, null);
            else if (reason === "cancelled") settle(threadId, session, true, "cancelled");
            else {
              const errorMessage = typeof result?.error === "string" && result.error
                ? result.error
                : typeof result?.message === "string" && result.message
                  ? result.message
                  : `Model turn failed: ${reason ?? "unknown error"}`;
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                message: errorMessage,
              });
              settle(threadId, session, false, reason ?? "failed");
            }
          } catch (e) {
            if (pendingSplitReceipt && state.promptSent && state.usageCompacted) {
              deletePromptSplitReceipt(DRIVER_KIND, pendingSplitReceipt.key);
            }
            if (!state.settled) {
              const message = e instanceof Error ? e.message : String(e);
              const code = support.classifyError?.(e);
              const needsAuth = code === "invalid_credentials" || code === "inactive_subscription"
                || code === "insufficient_funds" || message === support.loginNote;
              const accountError = isAccountError(code);
              const failure = classifyError({ text: message });
              const transientStartup = failure.transient || (failure.reason === "unknown" && code === "upstream_outage");
              const denied = /\b(?:(?:permission|access) denied|(?:approval|permission) (?:required|denied|rejected)|requires? (?:approval|permission)|policy (?:restriction|violation)|(?:blocked|denied|restricted) by (?:the )?policy)\b/i.test(message);
              const retryableStartup = approvalUnconfirmed || (transientStartup && (!code || code === "upstream_outage")
                && ![-32700, -32600, -32601, -32602].includes((e as any)?.code));
              if (turn.startupRecovery && retryableStartup && !needsAuth && !accountError && !denied
                  && !state.promptSent && !state.startupActivity && !state.producedItem && !state.text
                  && !state.stopped && !session.closing && !asks.size && !current.runningTools.size) {
                state.settled = true;
                session.current = null;
                if (current.interruptTimer) clearTimeout(current.interruptTimer);
                closeSession(threadId, "startup-recovery");
                const stopped = await killCliTree(session.child).catch(() => false);
                if (current.interruptTimer) clearTimeout(current.interruptTimer);
                active.delete(threadId);
                if (stopped && !state.stopped) {
                  rejectStartup(new TurnNotStartedError(turnId, message));
                  return;
                }
                acknowledge();
                if (!state.stopped) emit({ ...base(threadId, turnId), type: "runtime.error", message });
                emit({ ...base(threadId, turnId), type: "turn.completed", ok: state.stopped,
                  stopReason: state.stopped ? "cancelled" : "rpc_error", cost: null });
                return;
              }
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                message: accountError ? support.describeAccountError?.(code, cliTurn.model) ?? message : message,
                ...(needsAuth ? { setup: true } : {}),
              });
              if (!needsAuth && !accountError && ((e as any)?.acpPromptStall === true || (e as any)?.acpSessionFailure === true
                  || code === "upstream_outage") && session.child.exitCode === null && !session.closing) {
                closeSession(threadId, (e as any)?.acpPromptStall === true ? "prompt-stall" : "rpc-failure");
              } else if (approvalUnconfirmed && session.child.exitCode === null && !session.closing) {
                closeSession(threadId, "approval-unconfirmed");
              } else if (staleProcess && !state.promptSent && session.child.exitCode === null && !session.closing) {
                closeSession(threadId, "stale-models");
              }
              settle(threadId, session, false, needsAuth ? "auth_required" : "rpc_error");
            }
          }
        })();

        return startupAck ?? { turnId };
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        const env = childEnv();
        if (support.snapshot) return support.snapshot(env, config, instanceId);
        const read = await readCliVersion(config.cli, env, (stdout, stderr) => versionFromProbe(stdout, stderr ?? ""));
        if (!("version" in read)) return unreadCli(config.cli, read);
        return { state: "available", version: read.version, authenticated: await support.isAuthenticated(env, config, instanceId) };
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        displayName: input.displayName,
        enabled: input.enabled,
        get models() {
          return models;
        },
        refreshModels: support.resolveModels ? refreshModels : undefined,
        ...(deviceSignIn ? {
          startAuthentication: () => deviceSignIn.start(),
          getAuthentication: (flowId: string) => deviceSignIn.get(flowId),
          cancelAuthentication: () => deviceSignIn.cancel(),
          ...(deviceSignIn.canSignOut ? { signOut: () => deviceSignIn.signOut() } : {}),
        } : {}),
        snapshot,
        adapter: {
          provider: DRIVER_KIND,
          capabilities: {
            sessionModelSwitch: "unsupported",
            agentsMcp: true,
        customMcp: true,
            computerMcp: true,
            composioMcp: true,
            browserMcp: true,
            images: support.images !== false,
            nativeImageInput: support.images === true,
            effortLevels: support.effortLevels,
            modelVariants: support.modelVariants === true,
            localComputerMcp: true,
          },
          sendTurn,
          interruptTurn: async (threadId) => active.get(threadId)?.interrupt(),
          respondToRequest: async (threadId, requestId, decision) => {
            const turn = active.get(threadId);
            const finish = turn?.asks.get(requestId);
            if (!finish) return "unavailable";
            return finish(decision.behavior, "user", decision.message, decision.always === true);
          },
          hasSession: (threadId) => active.has(threadId),
          stopAll: async () => {
            for (const { stop } of active.values()) stop();
            for (const threadId of Array.from(sessions.keys())) closeSession(threadId, "stopAll");
            for (const [threadId, children] of retiring) {
              for (const child of children) void retireChild(threadId, child);
            }
          },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        dispose: async () => {
          await deviceSignIn?.dispose();
          for (const { stop } of active.values()) stop();
          for (const threadId of Array.from(sessions.keys())) closeSession(threadId, "dispose");
          for (const [threadId, children] of retiring) {
            for (const child of children) void retireChild(threadId, child);
          }
          listeners.clear();
        },
      };
    },
  };
}
