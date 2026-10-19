
import type { ApprovalMode } from "../shared/approval-mode.ts";
import type { ToolScope } from "../shared/tool-scope.ts";
import type { EffortLevel } from "../shared/wire.ts";
import type {
  DriverKind, InstanceId, ModelVariantOption, RuntimeEventListener, ThreadId, TurnId,
} from "../shared/runtime-events.ts";
import type { ProviderIcon } from "../shared/provider-icon.ts";

export type { CloudBackend, EffortLevel, ModelSelection } from "../shared/wire.ts";
export type {
  DriverKind, InstanceId, ModelVariantOption, ModelVariantState, RuntimeEvent,
  RuntimeEventBase, RuntimeEventListener, ThreadId, TurnId,
} from "../shared/runtime-events.ts";


export type ProviderErrorCode =
  | "missing_cli"
  | "invalid_credentials"
  | "inactive_subscription"
  | "insufficient_funds"
  | "quota_or_region_restriction"
  | "upstream_outage"
  | "model_catalog_outage";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderError";
    this.code = code;
  }
}

export class TurnNotStartedError extends Error {
  readonly turnId: TurnId;

  constructor(turnId: TurnId, message: string) {
    super(message);
    this.name = "TurnNotStartedError";
    this.turnId = turnId;
  }
}


export function isModelVariant(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !/\p{Cc}/u.test(value);
}


export interface TurnImageInput {
  path: string;
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  bytes: number;
}

export interface InstanceConfig {
  driver: DriverKind;
  displayName?: string;
  accentColor?: string;
  icon?: ProviderIcon;
  environment?: Record<string, string>;
  enabled?: boolean;
  access?: EngineAccess;
  config?: unknown;
}

export type InstanceConfigMap = Record<InstanceId, InstanceConfig>;

export type RequestOutcome = "allowed-once" | "rejected" | "answered" | "unavailable";

export interface SendTurnInput {
  threadId: ThreadId;
  botId?: string;
  text: string;
  approvalMode?: ApprovalMode;
  reviewerGrant?: { environment: string[]; allow: string[] };
  toolScope?: ToolScope;
  guestConfined?: boolean;
  confinedWhy?: string;
  images?: TurnImageInput[];
  model?: string;
  effort?: EffortLevel;
  variant?: string;
  fast?: boolean;
  quietWork?: boolean;
  resumeCursor?: unknown;
  sessionReset?: boolean;
  startupRecovery?: boolean;
  recoveryText?: string;
  recoveryIsReplay?: boolean;
  transcript?: Array<{ role: "user" | "assistant"; text: string }>;
  system?: string;
  systemStable?: string;
  systemVolatile?: string;
  mentionTurn?: boolean;
  integrations?: {
    composio?: { command: string; args: string[]; env: Record<string, string> };
    localComputer?: {
      command: string;
      args: string[];
      env: Record<string, string>;
      platform?: "darwin" | "linux" | "win32";
      generation?: string;
      scope?: "local-computer";
    };
    hooks?: { url: string; token: string };
    agents?: { command: string; args: string[]; env: Record<string, string> };
    browser?: { command: string; args: string[]; env: Record<string, string> };
    custom?: Record<string, McpServerSpec>;
  };
  cwd?: string;
  mcpFromUserConfig?: boolean;
  mcpCallTimeoutMs?: number;
}

export interface StdioMcpSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface RemoteMcpSpec {
  type: "http" | "sse";
  url: string;
  headers: Record<string, string>;
}

export type McpServerSpec = StdioMcpSpec | RemoteMcpSpec;

export interface TurnStartResult {
  turnId: TurnId;
}

export interface ProviderAdapter {
  readonly provider: DriverKind;
  readonly capabilities: {
    sessionModelSwitch: "in-session" | "unsupported";
    agentsMcp?: boolean;
    computerMcp?: boolean;
    composioMcp?: boolean;
    browserMcp?: boolean;
    images?: boolean;
    nativeImageInput?: boolean;
    effortLevels?: readonly EffortLevel[];
    modelVariants?: boolean;
    fastMode?: boolean;
    queueing?: boolean;
    steerImages?: boolean;
    localComputerMcp?: boolean;
    customMcp?: boolean;
    strictResume?: boolean;
    hooks?: boolean;
    guestTurns?: "confined";
  };
  sendTurn(input: SendTurnInput): Promise<TurnStartResult>;
  interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void>;
  respondToRequest(
    threadId: ThreadId,
    requestId: string,
    decision: {
      behavior: "allow" | "deny" | "answer";
      message?: string;
      always?: boolean;
    },
  ): Promise<RequestOutcome>;
  steer?(threadId: ThreadId, text: string, images?: TurnImageInput[]): Promise<SteerOutcome>;
  hasSession(threadId: ThreadId): boolean;
  stopAll(): Promise<void>;
  onEvent(listener: RuntimeEventListener): () => void;
}

export type SteerOutcome = "steered" | "refused" | "indeterminate";

export interface ProviderSnapshot {
  chatgptPlan?: boolean;
  authenticationUnavailableReason?: string;
  state: "available" | "unavailable";
  reason?: string;
  authenticated?: boolean;
  account?: { email?: string; organization?: string; method?: "login" | "api-key" };
  version?: string | null;
  update?: {
    title: string;
    message: string;
    command: string;
  };
  billing?: "metered" | "subscription";
  warning?: {
    title: string;
    message: string;
  };
}

export interface EngineInstall {
  command?: Partial<Record<"darwin" | "win32" | "linux", string>>;
  docsUrl?: string;
  signInCommand?: string;
  needsNode?: boolean;
  managed?: {
    label: string;
    downloadBytes: number;
  };
  settings?: "connections";
  server?: { package: string; native?: boolean };
}

export interface ProviderAuthenticationStart {
  phase: "waiting" | "succeeded";
  flowId: string | null;
  authorizationUrl: string | null;
  expiresAt: string | null;
  userCode?: string;
  callbackUrl?: string;
}

export interface ProviderAuthenticationStatus extends Omit<ProviderAuthenticationStart, "phase"> {
  phase: "waiting" | "succeeded" | "failed" | "expired" | "cancelled";
  message?: string;
}

export interface ModelCatalog {
  default: string;
  options: Array<{
    id: string;
    label: string;
    custom?: boolean;
    loaded?: boolean;
    provider?: string;
    contextWindow?: number;
    variants?: ModelVariantOption[];
    effortLevels?: readonly EffortLevel[];
    defaultEffort?: EffortLevel;
  }>;
}

export function titleCaseModelId(id: string, wordBreaks: RegExp): string {
  return id
    .split(wordBreaks)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function qualifiedModelLabel(
  id: string,
  qualifier: string | null | undefined,
  options: {
    redundantWhen?: (id: string, qualifier: string) => boolean;
    decorate?: (qualifier: string) => string;
  } = {},
): string {
  const { redundantWhen = () => false, decorate = (facet) => ` — ${facet}` } = options;
  if (!qualifier || redundantWhen(id, qualifier)) return id;
  return `${id}${decorate(qualifier)}`;
}

export interface DriverCreateInput<Config> {
  instanceId: InstanceId;
  displayName: string | undefined;
  environment: Record<string, string>;
  enabled: boolean;
  config: Config;
}

export interface TextGenerationUsage {
  model: string;
  input?: number;
  output?: number;
  cachedInput?: number;
  costUsd?: number;
}

export interface TextGenerationOptions {
  signal?: AbortSignal;
  onUsage?: (usage: TextGenerationUsage) => void;
}

export interface ProviderInstance {
  readonly instanceId: InstanceId;
  readonly driverKind: DriverKind;
  readonly displayName: string | undefined;
  readonly enabled: boolean;
  readonly models: ModelCatalog;
  readonly refreshModels?: () => Promise<void>;
  readonly installRuntime?: () => Promise<void>;
  readonly startAuthentication?: () => Promise<ProviderAuthenticationStart>;
  readonly authenticationMethod?: "browser-pkce";
  readonly getAuthentication?: (flowId: string) => Promise<ProviderAuthenticationStatus>;
  readonly completeAuthentication?: (flowId: string, callbackUrl: string) => Promise<void>;
  readonly cancelAuthentication?: () => Promise<void>;
  readonly signOut?: () => Promise<void>;
  readonly adapter: ProviderAdapter;
  snapshot(): Promise<ProviderSnapshot>;
  generateText?(prompt: string, options?: TextGenerationOptions): Promise<string>;
  reviewPermission?(prompt: string, signal?: AbortSignal): Promise<string>;
  dispose(): Promise<void>;
}

export type EngineAccess = "subscription" | "custom" | "api";

export interface ProviderDriver<Config = unknown> {
  readonly driverKind: DriverKind;
  readonly metadata: {
    displayName: string;
    supportsMultipleInstances?: boolean;
    access?: EngineAccess;
  };
  readonly install?: EngineInstall;
  decodeConfig(raw: unknown): Config;
  defaultConfig(): Config;
  readonly models: ModelCatalog;
  create(input: DriverCreateInput<Config>): Promise<ProviderInstance>;
}

export type AnyProviderDriver = ProviderDriver<any>;

let eventCounter = 0;
export const newEventId = () => `ev-${Date.now().toString(36)}-${(eventCounter++).toString(36)}`;
export const newId = () => crypto.randomUUID();
