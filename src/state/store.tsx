import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import type { BotVisibility, CardAnswerer, CloudBackend, ConnectorToolGrant, EffortLevel, InstalledPackageMetadata, LiveCallState, LiveSettings, ServerFrame, GroupThreadUsage, SteerQueueReason } from "../../shared/wire";
import type { TurnDigest } from "../../shared/digest";
import type { ToolScope } from "../../shared/tool-scope";
import type { ModelVariantOption, RuntimeEvent } from "../../shared/runtime-events";
import type { DogColor, DogMotion } from "@/lib/mascot";
import type { BotAvatarCrop } from "../../shared/bot-avatar";
import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode";
import { MAC_ALLOW_KEY } from "../../shared/cloud-home";
import { sameModelSelection } from "../../shared/thread-model";
import type { MascotBodyId } from "../../shared/mascot-bodies";
import type { QuestionRequestCardData } from "../../shared/ask-question";
import type { ProfileRequestCardData } from "../../shared/profile-request";
import type { ModelRequestCardData } from "../../shared/model-request";
import type { RoutineRequestCardData } from "../../shared/routine-request";
import type { RoutineRunCardData } from "../../shared/routine-run";
import type { GroupGoalRunCardData } from "../../shared/group-goal-run";
import type { SecureFormCardData } from "../../shared/secure-form";
import type { PlaceRow } from "../../shared/place-view";
import type { FailedTurnQuota } from "../../shared/failed-turn";
import type { SendDelivery } from "../../shared/send-delivery";
import {
  reviewedSkillSha256,
  skillRequestBehavior,
  type SkillRequestCardData,
} from "../../shared/skill-request";
import type { Routine, RoutineInput, RoutineRun } from "@/lib/routines";
import type { WebhookAttempt, WebhookIngressStatus, WebhookTrigger } from "@/lib/webhooks";
import { botShowsUnread } from "@/lib/bot-unread";
import { personIsLooking, readWhenBack } from "@/lib/viewing";
import { jevRoomRoutingOn } from "@/lib/group-routing";
import { descendsFrom, newestTip } from "@/lib/leaf-follow";
import type { ComputerStart } from "@/lib/computer-start";
import { answerResponse, dismissResponse } from "@/lib/card-answer";
import { currentCall } from "@/lib/call";
import { showNotification, type NotificationTarget } from "@/lib/notify";
import { speaker } from "@/lib/tts";
import { createBotPatchQueue, type BotUpdatePatch } from "./bot-patch-queue";
import type { OnboardingStatus } from "@/lib/onboarding";
import { openLiveEvents, publishLiveFrame, publishMissedFrames } from "@/lib/live-events";
import { plainClientError, statusFallback } from "@/lib/plain-client-error";
import { SEND_ATTEMPT_TIMEOUT_MS, UncertainSends, isUncertainSendFailure, sendWithRetry } from "@/lib/send-retry";
import { receiveHelperEvent, receiveHelpersSnapshot, forgetHelpers } from "@/lib/helpers-state";
import { receiveReasoningEvent, forgetReasoning } from "@/lib/turn-reasoning";

const MAX_ROUTINE_RUNS = 2_000;
const ACTIVE_ROUTINE_RUN_STATUSES = new Set<RoutineRun["status"]>(["queued", "running", "waiting"]);

function trimRoutineRuns(runs: readonly RoutineRun[]): RoutineRun[] {
  const sorted = [...runs].sort((a, b) => b.scheduledFor - a.scheduledFor);
  if (sorted.length <= MAX_ROUTINE_RUNS) return sorted;
  const activeCount = sorted.reduce(
    (count, run) => count + (ACTIVE_ROUTINE_RUN_STATUSES.has(run.status) ? 1 : 0),
    0,
  );
  let terminalSlots = Math.max(0, MAX_ROUTINE_RUNS - activeCount);
  return sorted.filter((run) => {
    if (ACTIVE_ROUTINE_RUN_STATUSES.has(run.status)) return true;
    if (terminalSlots === 0) return false;
    terminalSlots -= 1;
    return true;
  });
}

export type { DogColor } from "@/lib/mascot";
export type { RoutineRunCardData } from "../../shared/routine-run";

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  requestType?: "permission" | "question";
  optionHints?: Record<string, string>;
  multiSelect?: boolean;
  answered?: string;
  answeredText?: string;
  answeredBy?: CardAnswerer;
  dismissed?: boolean;
  requestId?: string;
  tool?: string;
  held?: string;
  expired?: boolean;
  heldCode?: string;
  allowKey?: string;
  allowSession?: boolean;
  answerScope?: "once" | "always" | "chat";
  commandAllowlist?: { command: string; cwd: string; providerInstanceId: string };
  approvalScope?: "local-computer";
  autoApplied?: boolean;
  undone?: boolean;
  routineRequest?: RoutineRequestCardData;
  skillRequest?: SkillRequestCardData;
  outboundRequest?: { tool: string; app: string | null; calls?: Array<{ app: string | null; label: string }> };
  teamMemoryRequest?: { section: string; entryId: string; kind: string };
  profileRequest?: ProfileRequestCardData;
  modelRequest?: ModelRequestCardData;
  teamSetupRequest?: import("../../shared/team-setup").TeamSetupRequest;
  questionRequest?: QuestionRequestCardData;
  takeoverRequest?: import("../../shared/takeover").TakeoverRequestCardData;
}

export interface ConnectorCardData {
  slug: string;
  label: string;
  description: string;
  status: "required" | "authorizing" | "connected" | "failed";
  resumeKey: string;
  alias?: string;
  error?: string;
  dismissed?: boolean;
  resumed?: boolean;
}

export interface SecretRequestCardData {
  target: import("../../shared/credential-request").CredentialTargetId;
  label: string;
  description: string;
  placeholder: string;
  helpUrl: string;
  requestKey: string;
  provided?: boolean;
  dismissed?: boolean;
  superseded?: boolean;
  resumed?: boolean;
  error?: string;
}

export interface Message {
  roomRequest?: import("../../shared/wire").WireMessage["roomRequest"];
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen" | "connector" | "secret" | "routine.run" | "goal.run" | "digest" | "compaction";
  text?: string;
  digest?: TurnDigest;
  compaction?: import("../../shared/wire").WireMessage["compaction"];
  attachments?: import("../../shared/wire").WireMessage["attachments"];
  card?: OptionCardData;
  connector?: ConnectorCardData;
  secret?: SecretRequestCardData;
  secureForm?: SecureFormCardData;
  routineRun?: RoutineRunCardData;
  goalRun?: GroupGoalRunCardData;
  channelMode?: "chat" | "goal";
  tool?: { name: string; ok?: boolean; spoken?: string; setup?: boolean; claudeUpdate?: boolean; place?: PlaceRow; quota?: FailedTurnQuota; carry?: { from: string; to: string }; resume?: { handoffId: string }; summary?: string; input?: string; output?: string ; itemId?: string; outputPath?: string; fullResult?: boolean; statusLine?: "live" | "folded" };
  steered?: boolean;
  via?: "api" | "call";
  turnId?: string;
  turnTerminal?: boolean;
  hasImage?: boolean;
  png?: string;
  mime?: string;
  at: number;
  parentId?: string | null;
  replyToId?: string;
  sendId?: string;
  from?: { botId: string; name: string; color: DogColor };
  peerAsk?: { botId: string; name: string; unattended?: boolean };
  reactions?: Array<{ emoji: string; by: string }>;
  comm?: { groupId: string; threadId?: string; withBotId: string; withName: string; withColor: DogColor; direction?: "to" | "from" };
  threadRef?: { botId: string; threadId: string; title: string };
  cloudTask?: import("../../shared/cloud-task").CloudTaskRef;
  queued?: boolean;
  queueId?: string;
  routedBy?: import("../../shared/wire").WireMessage["routedBy"];
}

export type GroupDefaultResponder = import("../../shared/wire").GroupDefaultResponder;

export interface Group {
  usage?: GroupThreadUsage | null;
  id: string;
  threadId: string;
  name: string;
  memberIds: string[];
  defaultResponder: GroupDefaultResponder;
  bulletin: string;
  unread: boolean;
  createdAt: number;
  dm?: boolean;
  busyBotId?: string | null;
  turnStartedAt?: number | null;
  working?: boolean;
  cwd?: string;
  pinnedCwd?: string | null;
  pinnedMessageId?: string;
  section?: string;
  setupCompletedAt?: number | null;
  setupSkippedAt?: number | null;
  turnTimeoutMinutes?: number | null;
  tasks?: GroupTask[];
  messages: Message[];
  hasMore?: boolean;
}

export interface GroupTask {
  threadId: string;
  title: string;
  createdAt: number;
  pinnedCwd?: string | null;
  pinnedMessageId?: string;
  pinned?: boolean;
  updatedAt?: number;
  turnTimeoutMinutes?: number;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  effort?: EffortLevel;
  variant?: string;
  fast?: boolean;
}

export interface Task {
  waitingForTeammates?: boolean;
  threadId: string;
  routineRunId?: string;
  projectId?: string;
  title: string;
  createdAt: number;
  pinned?: boolean;
  updatedAt?: number;
  usage?: TaskUsage;
  cwd?: string | null;
  modelSelection?: ModelSelection;
  followsBotModel?: boolean;
  approvalMode?: ApprovalMode;
  autoApprove?: boolean;
  alwaysAllow?: string[];
  activity?: Bot["activity"];
  busy?: boolean;
  turnStartedAt?: number;
  workingStartedAt?: number;
  unread?: boolean;
  pinnedMessageId?: string;
  surface?: "cloud" | "vm" | "local" | "browser";
  surfaceAuto?: true;
  openedBy?: ThreadOpener;
  closedBy?: ThreadCloser;
  archivedAt?: number;
  snoozedUntil?: number;
}

export interface ThreadOpener {
  botId: string;
  name: string;
  delegationId?: string;
  at: number;
}

export interface ThreadCloser {
  botId: string;
  name: string;
  at: number;
}

export interface TaskUsage {
  input: number;
  output: number;
  cachedInput?: number;
  costUsd: number | null;
  turns: number;
  lastTurn?: { input: number; output: number; cachedInput?: number; costUsd: number | null };
  context?: { tokens: number; window?: number };
}

export interface Bot {
  toolScope?: ToolScope;
  waitingForTeammates?: boolean;
  id: string;
  threadId: string;
  tasks?: Task[];
  projects?: BotProject[];
  name: string;
  formerNames?: string[];
  title: string;
  description: string;
  soul?: string;
  soulDrift?: boolean;
  notifications: boolean;
  color: DogColor;
  mascotExpression?: string | null;
  mascotBody?: MascotBodyId | null;
  avatarUrl?: string | null;
  avatarCrop?: BotAvatarCrop;
  avatarZoom?: number;
  avatarFocusX?: number;
  avatarFocusY?: number;
  unread: boolean;
  busy?: boolean;
  activity?: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead" | "parked.computer";
  turnStartedAt?: number | null;
  workingStartedAt?: number | null;
  modelSelection: ModelSelection;
  computer?: "cloud" | "vm" | "local" | "browser" | "off";
  cloudBackend?: CloudBackend;
  autoStartVps?: boolean;
  cwd?: string;
  autoApprove?: boolean;
  approvalMode?: ApprovalMode;
  alwaysAllow?: string[];
  speakReplies?: boolean;
  voice?: string;
  voiceNotes?: boolean;
  memoryEnabled?: boolean;
  pinned?: boolean;
  hidden?: boolean;
  section?: string;
  pinnedMessageId?: string;
  chiefOfStaff?: boolean;
  managedSections?: string[];
  approvePeerComms?: boolean;
  peers?: string[];
  composio?: boolean;
  connectorTools?: Record<string, ConnectorToolGrant>;
  connectorScopes?: { apps: Record<string, "read" | "write"> };
  outbound?: { policy: "ask" | "allow"; dailyCap: number };
  fallback?: Array<{ instanceId: string; model: string }>;
  browser?: boolean;
  memoryUpkeep?: boolean;
  mcpServers?: string[] | null;
  browserProfile?: string | null;
  visibility?: BotVisibility;
  installedPackage?: InstalledPackageMetadata;
  messages: Message[];
  hasMore?: boolean;
  awaitingThreadSnapshot?: boolean;
  activeLeafId?: string | null;
}

export interface BotProject {
  id: string;
  name: string;
  emoji?: string;
}

export type ProjectUpdatePatch = { name?: string; emoji?: string | null };

export function currentTaskBot(bot: Bot, threadId = bot.threadId): Bot {
  const task = bot.tasks?.find((candidate) => candidate.threadId === threadId);
  if (!task) return bot;
  return {
    ...bot,
    threadId,
    modelSelection: task.modelSelection ?? bot.modelSelection,
    approvalMode: task.approvalMode ?? (task.autoApprove === undefined ? bot.approvalMode : undefined),
    autoApprove: task.autoApprove ?? bot.autoApprove,
    alwaysAllow: task.alwaysAllow ?? bot.alwaysAllow,
    activity: task.activity ?? bot.activity,
    busy: task.busy ?? (task.activity ? task.activity === "working" || task.activity === "waiting-on-you" : bot.busy),
    unread: task.unread ?? bot.unread,
    pinnedMessageId: task.pinnedMessageId,
    turnStartedAt: task.turnStartedAt ?? null,
    workingStartedAt: task.workingStartedAt ?? null,
    waitingForTeammates: task.waitingForTeammates ?? false,
  };
}

export type TaskUpdatePatch = Partial<Pick<Task, "modelSelection" | "approvalMode" | "autoApprove" | "pinnedMessageId">> & {
  confirmFullAccess?: boolean;
  acknowledgeLocalAuto?: boolean;
  updateBotDefault?: boolean;
  resetApprovalToAsk?: boolean;
  projectId?: string | null;
  archivedAt?: number | null;
  snoozedUntil?: number | null;
  surface?: Task["surface"] | null;
  pinned?: boolean;
};

function taskPatchFields(patch: TaskUpdatePatch): Partial<Task> {
  const { confirmFullAccess: _fullConsent, acknowledgeLocalAuto: _localAck, updateBotDefault: _modelDefault, resetApprovalToAsk, projectId, archivedAt, snoozedUntil, surface, pinned, ...fields } = patch;
  return { ...fields, ...(resetApprovalToAsk ? { approvalMode: "ask", autoApprove: false, alwaysAllow: [] } : {}),
    ...(projectId === undefined ? {} : { projectId: projectId ?? undefined }),
    ...(archivedAt === undefined ? {} : { archivedAt: archivedAt ?? undefined }),
    ...(snoozedUntil === undefined ? {} : { snoozedUntil: snoozedUntil ?? undefined }),
    ...(surface === undefined ? {} : { surface: surface ?? undefined, surfaceAuto: undefined }),
    ...(pinned === undefined ? {} : { pinned: pinned ? true : undefined }) };
}

function mergeTaskStamps<T extends { threadId: string; updatedAt?: number }>(previous: T[] | undefined, incoming: T[] | undefined): T[] | undefined {
  if (!incoming) return previous;
  const prior = new Map((previous ?? []).map((task) => [task.threadId, task.updatedAt]));
  return incoming.map((task) => {
    const local = prior.get(task.threadId);
    if (typeof local !== "number") return task;
    const remote = task.updatedAt;
    const updatedAt = typeof remote === "number" ? Math.max(local, remote) : local;
    return updatedAt === task.updatedAt ? task : { ...task, updatedAt };
  });
}

function bumpThreadUpdatedAt(state: AppState, threadId: string, at: number): AppState {
  if (!Number.isFinite(at)) return state;
  const advance = <T extends { threadId: string; updatedAt?: number }>(tasks: T[] | undefined) =>
    tasks?.some((task) => task.threadId === threadId)
      ? tasks.map((task) => task.threadId === threadId ? { ...task, updatedAt: Math.max(task.updatedAt ?? 0, at) } : task)
      : tasks;
  return {
    ...state,
    bots: state.bots.map((bot) => {
      const tasks = advance(bot.tasks);
      return tasks === bot.tasks ? bot : { ...bot, tasks };
    }),
    groups: state.groups.map((group) => {
      const tasks = advance(group.tasks);
      return tasks === group.tasks ? group : { ...group, tasks };
    }),
  };
}

function rewindThreadUpdatedAt(state: AppState, threadId: string, messages: { at: number }[], createdAt: number): AppState {
  const at = messages.reduce((max, message) => Math.max(max, message.at || 0), createdAt);
  const apply = <T extends { threadId: string; updatedAt?: number }>(tasks: T[] | undefined) =>
    tasks?.map((task) => task.threadId === threadId ? { ...task, updatedAt: at } : task);
  return {
    ...state,
    bots: state.bots.map((bot) => bot.tasks?.some((task) => task.threadId === threadId) ? { ...bot, tasks: apply(bot.tasks) } : bot),
    groups: state.groups.map((group) => group.tasks?.some((task) => task.threadId === threadId) ? { ...group, tasks: apply(group.tasks) } : group),
  };
}

export function visibleMessages(bot: Pick<Bot, "messages" | "activeLeafId">): Message[] {
  const leafId = bot.activeLeafId;
  if (!leafId) return bot.messages;
  const byId = new Map(bot.messages.map((m) => [m.id, m]));
  if (!byId.has(leafId)) return bot.messages;
  const path: Message[] = [];
  let cur = byId.get(leafId);
  while (cur) {
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

export interface ConfigStatus {
  xai?: { configured: boolean };
  mistral?: { configured: boolean };
  cerebras?: { configured: boolean };
  anthropic?: { configured: boolean; everyClaudeBot?: boolean };
  openai?: { configured: boolean };
  openrouter?: { configured: boolean };
  openaiCompat?: { configured: boolean; url?: string };
  edition?: {
    edition: "oss" | "enterprise";
    features: string[];
    license?: { expiresAt: string; expiresInDays: number; graceEndsAt?: string };
  };
  fleet?: { available: boolean };
  budgets?: { monthlyUsd?: number; warnAtPercent?: number };
  billing?: { currency?: string; prices?: Record<string, { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion?: number }> };
  composio: { configured: boolean; mode?: "managed" | "self-hosted" | "unavailable" };
  box: { configured: boolean; included?: boolean; provider?: "laterdog"; trial?: boolean };
  vps: { configured: boolean; sshAlias: string };
  rooms: { turnTimeoutMinutes: number };
  mcp?: { callTimeoutMinutes: number };
  newBots?: { effort?: EffortLevel };
  threads?: { maxConcurrentPerBot: number; eventLogMaxBytes?: number; eventLogRetentionDays?: number };
  automaticRecovery?: { enabled: boolean; backup?: ModelSelection };
  accountBattery?: {
    enabled: boolean;
    auto?: boolean;
    sequence?: string[];
    order: Record<string, string[]>;
    resting?: Record<string, { until: string; since?: string; kind?: string; estimated?: boolean; sharedWith?: string }>;
    waiting?: Record<string, string>;
    routed?: Record<string, { from: string; on: string }>;
  };
  localVm: { mode: "shared" | "per-bot" | "pool"; maxInstances: number; idleTimeoutMinutes?: number };
  opencodeGo?: { configured: boolean; providerKeys?: string[] };
  tts?: {
    configured: boolean;
    ready: boolean;
    voice: string;
    provider?: "elevenlabs" | "fish" | "system" | "chatterbox" | "xai";
    baseUrl?: string;
    model?: string;
    fishModel?: "s2.1-pro" | "s2.1-pro-free";
    included?: boolean;
  };
  decider?: {
    provider: "jev";
    configured: boolean;
    included?: boolean;
    enabled: boolean;
    jobs: { roomRouting: boolean };
  };
  typing?: {
    enabled: boolean;
    smarter: boolean;
    included: boolean;
    cloudflare: { configured: boolean; accountId: string; model: string };
    ranking: boolean;
  };
  live?: LiveSettings;
  imageGen?: {
    configured: boolean;
    provider?: "openai" | "xai" | "custom";
    model?: string;
    customUrl?: string;
    customModel?: string;
    openaiConfigured?: boolean;
    xaiConfigured?: boolean;
    customKeyConfigured?: boolean;
  };
  profile?: { name: string; email: string; aboutMe?: string };
  language?: string;
  features?: { skillAuthoring: boolean; showToolCalls?: boolean; stepUpdates?: boolean; browser?: boolean; sharedComputers?: boolean; claudeUserMcp?: boolean; llmThreadTitles?: boolean; skillsLibrary?: boolean; cloudDictation?: boolean; typingSuggestions?: boolean; smarterSuggestions?: boolean };
  onboarding?: OnboardingStatus;
  browserEngine?: BrowserEngineSummary;
  browserProfiles?: BrowserProfile[];
  managedPolicy?: ManagedPolicySummary | null;
  cloudHome?: boolean;
}

export interface ManagedPolicySummary {
  organizationName: string;
  version: number;
  companyModelsOnly: boolean;
  allowedEngines: "all" | string[];
  mcp: { allowCustom: boolean; allowlist: string[] };
  computers: { thisComputer: boolean; localVm: boolean; box: boolean; vps: boolean };
  remoteAccess: boolean;
}

export interface BrowserEngineSummary {
  kind: "engine" | "unavailable";
  reason?: string;
  installable?: boolean;
  version?: string;
  installing?: boolean;
  installError?: string;
}

export interface BrowserProfile {
  id: string;
  name: string;
  partitionId?: string;
}

export type ConfigStatusFrame = Pick<
  ConfigStatus,
  "xai" | "mistral" | "cerebras" | "anthropic" | "openai" | "openrouter" | "openaiCompat" | "fleet" | "composio" | "box" | "vps" | "rooms" | "mcp" | "threads" | "automaticRecovery" | "accountBattery" | "localVm" | "opencodeGo" | "tts" | "decider" | "typing" | "imageGen" | "live" | "profile" | "language" | "features" | "onboarding" | "browserEngine" | "browserProfiles" | "edition" | "budgets" | "billing" | "managedPolicy" | "cloudHome"
>;

export function configStatusFromFrame(frame: ConfigStatusFrame): ConfigStatus {
  return {
    xai: frame.xai,
    mistral: frame.mistral,
    cerebras: frame.cerebras,
    anthropic: frame.anthropic,
    openai: frame.openai,
    openrouter: frame.openrouter,
    openaiCompat: frame.openaiCompat,
    fleet: frame.fleet,
    composio: frame.composio,
    box: frame.box,
    vps: frame.vps,
    rooms: frame.rooms,
    mcp: frame.mcp,
    threads: frame.threads,
    automaticRecovery: frame.automaticRecovery,
    accountBattery: frame.accountBattery,
    localVm: frame.localVm,
    opencodeGo: frame.opencodeGo,
    tts: frame.tts,
    decider: frame.decider,
    typing: frame.typing,
    imageGen: frame.imageGen,
    live: frame.live,
    profile: frame.profile,
    language: frame.language,
    features: frame.features,
    onboarding: frame.onboarding,
    browserEngine: frame.browserEngine,
    browserProfiles: frame.browserProfiles,
    edition: frame.edition,
    budgets: frame.budgets,
    billing: frame.billing,
    managedPolicy: frame.managedPolicy,
    ...(frame.cloudHome ? { cloudHome: true } : {}),
  };
}

export interface EngineInstall {
  command?: Partial<Record<"darwin" | "win32" | "linux", string>>;
  docsUrl?: string;
  signInCommand?: string;
  needsNode?: boolean;
  managed?: { label: string; downloadBytes: number };
  server?: { package: string };
  settings?: "connections";
}

export interface InstanceInfo {
  instanceId: string;
  driverKind: string;
  displayName: string;
  icon?: import("../../shared/provider-icon").ProviderIcon;
  readOnly?: boolean;
  managed?: { organizationId: string; organizationName: string };
  policy?: { organizationName: string; reason: string };
  snapshot: {
    state: "available" | "unavailable";
    reason?: string;
    authenticated?: boolean;
    chatgptPlan?: boolean;
    authenticationUnavailableReason?: string;
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
  };
  models: { default: string; options: Array<{ id: string; label: string; custom?: boolean; loaded?: boolean; provider?: string; variants?: ModelVariantOption[]; effortLevels?: readonly EffortLevel[]; defaultEffort?: EffortLevel }> };
  capabilities?: {
    computerMcp?: boolean;
    agentsMcp?: boolean;
    composioMcp?: boolean;
    browserMcp?: boolean;
    images?: boolean;
    effortLevels?: readonly EffortLevel[];
    modelVariants?: boolean;
    fastMode?: boolean;
    queueing?: boolean;
    steerImages?: boolean;
    localComputerMcp?: boolean;
    approvalReview?: boolean;
  };
  access?: "subscription" | "custom" | "api";
  authentication?: { method: "device-code" | "paste-code" | "browser" | "browser-pkce"; signOut?: boolean };
  install?: EngineInstall;
  cli?: string;
  cliDefault?: string;
  cliCandidates?: string[];
  claudeAccount?: { configDir: string; signInCommand: string; signInShell: "powershell" | "sh"; isDefault: boolean };
  freeUpSpace?: boolean;
}

export type AppSettingsSection = "general" | "models" | "computer" | "usage" | "updates";

export type BotSettingsSection =
  | "overview"
  | "identity"
  | "slack"
  | "soul"
  | "skills"
  | "memory"
  | "routines"
  | "access"
  | "model"
  | "permissions"
  | "voice"
  | "visibility"
  | "history"
  | "usage";

export interface ModelVariantSession {
  instanceId: string;
  model: string;
  turnId: string;
  startedAt: string;
  acceptingUpdates: boolean;
  variants?: { options: ModelVariantOption[]; currentValue?: string };
}

export interface AppState {
  bots: Bot[];
  groups: Group[];
  sections?: string[];
  instances: InstanceInfo[];
  modelVariantSessions: Record<string, ModelVariantSession>;
  config: ConfigStatus | null;
  liveCall: LiveCallState | null;
  liveCallVersion: number;
  liveCallLookupSeq: number;
  selectedId: string;
  activeView: "chat" | "team-map" | "workspace";
  routines: Routine[];
  routineRuns: RoutineRun[];
  routinesLoadState: "loading" | "ready" | "error";
  webhooks: WebhookTrigger[];
  webhookAttempts: WebhookAttempt[];
  webhookIngress: WebhookIngressStatus | null;
  settingsOpen: boolean;
  pluginsOpen: boolean;
  pluginsSurface: "apps" | "mcp";
  triggersOpen: boolean;
  newBotOpen: boolean;
  botCreationPending: boolean;
  computerOpen: boolean;
  cloudTaskId: string | null;
  inspectorOpen: boolean;
  activityOpen: boolean;
  appSettingsOpen: boolean;
  appSettingsSection: AppSettingsSection;
  shortcutsOpen: boolean;
  welcomeOpen: boolean;
  tourOpen: boolean;
  botSettingsSection: BotSettingsSection;
  botSettingsExpandAccordion: boolean;
  computerStarts: Record<string, ComputerStart>;
  deletingBots: Record<string, true>;
  computerControl: Record<string, { held: boolean; helpReason: string | null }>;
  takeoverIntent: { botId: string; at: number } | null;
  focusMessage: { threadId: string; messageId: string; matchText?: string; nonce: number; consumed: boolean } | null;
  connected: boolean;
  hydrated?: boolean;
  error: string | null;
  notice: { kind: "thread-gone"; botName: string | null } | null;
  revealThread: { threadId: string; nonce: number } | null;
  mascotMotion: {
    botId: string;
    nonce: number;
    kind: Exclude<DogMotion, "none">;
  } | null;
  pendingQueued: Record<string, Array<{ queueId: string; text: string; reason?: SteerQueueReason }>>;
  consumedQueueIds: Record<string, true>;
  backgroundThreadEvents: Record<string, Array<Extract<Action, { type: "messageAdded" | "messagePatched" | "threadActive" | "optimisticMessageRemoved" }>>>;
  loadingOlder: Record<string, true>;
  transcriptGeneration: Record<string, number>;
}

const MAX_CONSUMED_QUEUE_IDS = 64;

function rememberConsumedQueueId(
  consumed: AppState["consumedQueueIds"],
  queueId: string,
): AppState["consumedQueueIds"] {
  const next = { ...consumed, [queueId]: true as const };
  const overflow = Object.keys(next).length - MAX_CONSUMED_QUEUE_IDS;
  if (overflow > 0) {
    for (const id of Object.keys(next).slice(0, overflow)) delete next[id];
  }
  return next;
}

interface QueueReceiptSnapshot {
  messages?: Message[];
}

function reconcileSnapshotQueues(
  state: AppState,
  conversations: QueueReceiptSnapshot[],
): AppState {
  const landed: Array<{ queueId: string; at: number }> = [];
  for (const conversation of conversations) {
    for (const message of conversation.messages ?? []) {
      if (message.queueId) landed.push({ queueId: message.queueId, at: message.at });
    }
  }
  if (landed.length === 0) return state;

  const landedIds = new Set(landed.map((entry) => entry.queueId));
  const pendingQueued: AppState["pendingQueued"] = {};
  for (const [threadId, entries] of Object.entries(state.pendingQueued)) {
    const waiting = entries.filter((entry) => !landedIds.has(entry.queueId));
    if (waiting.length > 0) pendingQueued[threadId] = waiting;
  }

  let consumedQueueIds: AppState["consumedQueueIds"] = {};
  landed.sort((left, right) => left.at - right.at);
  for (const entry of landed) {
    consumedQueueIds = rememberConsumedQueueId(consumedQueueIds, entry.queueId);
  }
  for (const queueId of Object.keys(state.consumedQueueIds)) {
    consumedQueueIds = rememberConsumedQueueId(consumedQueueIds, queueId);
  }
  return { ...state, pendingQueued, consumedQueueIds };
}

function replaceBotQueues(state: AppState, queues: AppState["pendingQueued"]): AppState {
  const groupThreads = new Set(state.groups.flatMap((group) => [group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]));
  const liveIds = new Set(Object.values(queues).flatMap((entries) => entries.map((entry) => entry.queueId)));
  const pendingQueued = { ...queues };
  let consumedQueueIds = state.consumedQueueIds;
  for (const [threadId, entries] of Object.entries(state.pendingQueued)) {
    if (groupThreads.has(threadId)) pendingQueued[threadId] = entries;
    else for (const entry of entries) {
      if (!liveIds.has(entry.queueId)) consumedQueueIds = rememberConsumedQueueId(consumedQueueIds, entry.queueId);
    }
  }
  return { ...state, pendingQueued, consumedQueueIds };
}

export type BotAnnouncement = Omit<Bot, "messages"> & { messages?: Message[] };

export type Action =
  | {
      type: "hydrate";
      bots: Bot[];
      groups: Group[];
      sections?: string[];
      computerControl: Record<string, { held: boolean; helpReason: string | null }>;
      botQueuedMessages?: AppState["pendingQueued"];
    }
  | { type: "botQueues"; queues: AppState["pendingQueued"] }
  | { type: "sections"; sections: string[] }
  | { type: "sectionDeleted"; section: string; sections: string[] }
  | { type: "showTeamMap" }
  | { type: "showWorkspace" }
  | { type: "showChat" }
  | { type: "routinesHydrated"; routines: Routine[]; runs: RoutineRun[] }
  | { type: "routinesLoadFailed" }
  | { type: "routinePatched"; routine: Routine }
  | { type: "routineDeleted"; routineId: string }
  | { type: "routineRunPatched"; run: RoutineRun }
  | { type: "webhooksHydrated"; webhooks: WebhookTrigger[]; attempts: WebhookAttempt[]; ingress: WebhookIngressStatus }
  | { type: "webhookPatched"; webhook: WebhookTrigger }
  | { type: "webhookAttempted"; attempt: WebhookAttempt }
  | { type: "webhookDeleted"; webhookId: string }
  | { type: "createRoutine"; input: RoutineInput }
  | { type: "updateRoutine"; routineId: string; patch: Partial<RoutineInput> }
  | { type: "deleteRoutine"; routineId: string }
  | { type: "runRoutine"; routineId: string; onStarted?: (run: RoutineRun) => void; onError?: (error: unknown) => void; onSettled?: () => void }
  | { type: "cancelRoutineRun"; runId: string }
  | { type: "groupPatched"; group: Partial<Group> & { id: string } }
  | { type: "groupDeleted"; groupId: string }
  | { type: "createGroup"; memberIds: string[]; name?: string; section?: string }
  | {
      type: "sendGroup";
      groupId: string;
      text: string;
      sendId?: string;
      replyToId?: string;
      threadId?: string;
      mode?: "chat" | "goal";
      onError?: () => void;
    }
  | {
      type: "patchGroup";
      groupId: string;
      patch: Partial<Pick<Group, "name" | "bulletin" | "memberIds" | "defaultResponder" | "pinnedMessageId" | "section">>;
    }
  | { type: "deleteGroup"; groupId: string }
  | { type: "newGroupTask"; groupId: string }
  | { type: "switchGroupTask"; groupId: string; threadId: string }
  | { type: "renameGroupTask"; groupId: string; threadId: string; title: string }
  | { type: "pinGroupTask"; groupId: string; threadId: string; pinned: boolean; title: string }
  | { type: "setConversationTurnLimit"; groupId: string; threadId: string; minutes: number | null; dm: boolean }
  | { type: "deleteGroupTask"; groupId: string; threadId: string }
  | { type: "interruptGroup"; groupId: string; threadId?: string; onError?: () => void }
  | { type: "instances"; instances: InstanceInfo[] }
  | { type: "configStatus"; config: ConfigStatus }
  | { type: "liveCall"; call: LiveCallState | null }
  | { type: "liveCallLookup"; call: LiveCallState | null; since: number; seq: number }
  | { type: "profileSaved"; profile: Partial<NonNullable<ConfigStatus["profile"]>> }
  | { type: "select"; id: string }
  | {
      type: "send";
      botId: string;
      text: string;
      sendId?: string;
      replyToId?: string;
      threadId?: string;
      deliver?: SendDelivery;
      onError?: () => void;
    }
  | { type: "pendingQueued"; threadId: string; queueId: string; text: string; reason?: SteerQueueReason }
  | { type: "consumePendingQueued"; threadId: string; queueId: string }
  | { type: "cancelQueued"; botId: string; queueId: string; threadId?: string; onCancelled?: () => void }
  | { type: "steerQueued"; botId: string; queueId: string; threadId?: string; onError?: () => void; onSettled?: () => void }
  | { type: "cancelGroupQueued"; groupId: string; threadId: string; queueId: string; onCancelled?: () => void }
  | { type: "steerGroupQueued"; groupId: string; queueId: string; threadId?: string; onError?: () => void; onSettled?: () => void }
  | { type: "editMessage"; botId: string; messageId: string; text: string; threadId?: string; sendId?: string }
  | { type: "switchBranch"; botId: string; messageId: string; threadId?: string }
  | { type: "threadActive"; threadId: string; activeLeafId: string }
  | { type: "loadOlderMessages"; threadId: string }
  | { type: "olderMessages"; threadId: string; generation: number; messages: Message[]; hasMore: boolean }
  | { type: "answerCard"; botId: string; messageId: string; answer: string; threadId?: string; groupId?: string }
  | { type: "dismissCard"; botId: string; messageId: string; threadId?: string; groupId?: string }
  | {
      type: "decideRequest";
      threadId: string;
      requestId: string;
      behavior: "allow" | "deny" | "answer";
      message?: string;
      reviewedSha256?: string;
      alwaysAllow?: { botId: string; key: string };
      always?: boolean;
      rememberCommand?: boolean;
      scope?: "once" | "always" | "chat";
      onError?: (message: string) => void;
    }
  | { type: "newTask"; botId: string; projectId?: string }
  | { type: "switchTask"; botId: string; threadId: string }
  | { type: "taskSwitched"; bot: Bot }
  | { type: "renameTask"; botId: string; threadId: string; title: string }
  | { type: "regenerateTaskTitle"; botId: string; threadId: string; onSettled?: (ok: boolean) => void }
  | { type: "deleteTask"; botId: string; threadId: string }
  | { type: "newBot"; name?: string; title?: string; avatarUrl?: string | null; avatarCrop?: Bot["avatarCrop"]; modelSelection?: ModelSelection; visibility?: BotVisibility; section?: string; offLeash?: boolean; preserveSelection?: boolean; onCreated?: (bot: Bot) => void; onError?: (message: string) => void }
  | { type: "botCreationPending"; on: boolean }
  | { type: "updateTask"; botId: string; threadId: string; patch: TaskUpdatePatch }
  | { type: "refreshTaskPermissions"; botId: string; threadId: string; acknowledgeLocalAuto?: boolean }
  | { type: "followBotModel"; botId: string }
  | { type: "createProject"; botId: string; name: string; emoji?: string | null; onCreated?: (project: BotProject) => void; onError?: (message: string) => void }
  | { type: "updateProject"; botId: string; projectId: string; patch: ProjectUpdatePatch; onSaved?: () => void; onError?: (message: string) => void }
  | { type: "deleteProject"; botId: string; projectId: string; onDeleted?: () => void; onError?: (message: string) => void }
  | { type: "reorderProjects"; botId: string; projectIds: string[]; onSaved?: () => void; onError?: (message: string) => void }
  | { type: "botAdded"; bot: Bot; preserveSelection?: boolean }
  | { type: "deleteBot"; botId: string }
  | { type: "botDeletionPending"; botId: string; on: boolean }
  | { type: "duplicateBot"; botId: string }
  | { type: "markUnread"; botId: string }
  | { type: "botPatched"; bot: BotAnnouncement }
  | { type: "messageAdded"; threadId: string; message: Message }
  | { type: "messagePatched"; threadId: string; message: Message }
  | { type: "optimisticMessageRemoved"; threadId: string; sendId: string; restoreLeafId?: string | null }
  | { type: "computerStart"; botId: string; start: ComputerStart | null }
  | { type: "computerControl"; botId: string; held: boolean; helpReason: string | null }
  | { type: "takeoverIntent"; intent: { botId: string; at: number } | null }
  | { type: "modelVariantRuntime"; event: RuntimeEvent }
  | { type: "setModel"; botId: string; selection: ModelSelection; threadId?: string; updateBotDefault?: boolean; resetApprovalToAsk?: boolean }
  | { type: "interrupt"; botId: string; threadId?: string; onError?: () => void }
  | { type: "connected"; value: boolean }
  | { type: "error"; message: string | null }
  | { type: "notice"; notice: AppState["notice"] }
  | { type: "revealThread"; threadId: string }
  | { type: "toggleSettings"; open?: boolean; section?: BotSettingsSection; botId?: string }
  | { type: "togglePlugins"; open?: boolean; surface?: "apps" | "mcp" }
  | { type: "toggleTriggers"; open?: boolean }
  | { type: "toggleNewBot"; open?: boolean }
  | { type: "toggleComputer"; open?: boolean }
  | { type: "openCloudTask"; jobId: string }
  | { type: "closeCloudTask" }
  | { type: "toggleInspector"; open?: boolean }
  | { type: "toggleActivity"; open?: boolean }
  | { type: "focusMessage"; threadId: string; messageId: string; matchText?: string }
  | { type: "focusMessageConsumed"; nonce: number }
  | { type: "toggleAppSettings"; open?: boolean; section?: AppSettingsSection }
  | { type: "toggleShortcuts"; open?: boolean }
  | { type: "toggleWelcome"; open?: boolean }
  | { type: "toggleTour"; open?: boolean }
  | { type: "giveTreat"; botId: string }
  | {
      type: "updateBot";
      botId: string;
      patch: BotUpdatePatch;
    };

function reconcileModelVariantSessions(state: AppState): AppState {
  const sessions = Object.entries(state.modelVariantSessions);
  const kept = sessions.filter(([threadId, session]) => {
    const owner = state.bots.find((bot) => bot.threadId === threadId || bot.tasks?.some((task) => task.threadId === threadId));
    if (!owner) return false;
    const selection = currentTaskBot(owner, threadId).modelSelection;
    return selection.instanceId === session.instanceId && selection.model === session.model;
  });
  return kept.length === sessions.length ? state : { ...state, modelVariantSessions: Object.fromEntries(kept) };
}

export function pinBotThreadAction(action: Action, bots: Bot[]): Action {
  if (!("botId" in action) || ("threadId" in action && action.threadId) ||
      !["send", "interrupt", "editMessage", "switchBranch", "answerCard", "dismissCard", "cancelQueued", "steerQueued"].includes(action.type)) return action;
  const botId = action.botId;
  const threadId = bots.find((bot) => bot.id === botId)?.threadId;
  return { ...action, threadId } as Action;
}

interface NotificationThreadOwner {
  id: string;
  threadId: string;
  tasks?: Array<{ threadId: string }>;
}

interface NotificationRoutingState {
  bots: NotificationThreadOwner[];
  groups: NotificationThreadOwner[];
}

export function visibleNotificationThread(
  state: NotificationRoutingState & Pick<AppState, "activeView" | "selectedId">,
): string | null {
  if (state.activeView !== "chat") return null;
  return (
    state.bots.find((candidate) => candidate.id === state.selectedId)?.threadId ??
    state.groups.find((candidate) => candidate.id === state.selectedId)?.threadId ??
    null
  );
}

export function openNotificationTarget(
  dispatch: (action: Action) => void,
  target: NotificationTarget,
  state: NotificationRoutingState,
) {
  const group = state.groups.find(
    (candidate) =>
      candidate.threadId === target.threadId ||
      (candidate.tasks ?? []).some((task) => task.threadId === target.threadId),
  );
  if (group) {
    dispatch({ type: "select", id: group.id });
    if (group.threadId !== target.threadId) {
      dispatch({ type: "switchGroupTask", groupId: group.id, threadId: target.threadId });
    }
    return;
  }
  const bot = state.bots.find((candidate) =>
    candidate.threadId === target.threadId || candidate.tasks?.some((task) => task.threadId === target.threadId)
  ) ?? state.bots.find((candidate) => candidate.id === target.botId);
  dispatch({ type: "select", id: bot?.id ?? target.botId });
  if (!bot) return;
  const known =
    bot.threadId === target.threadId ||
    (bot.tasks ?? []).some((task) => task.threadId === target.threadId);
  if (known) dispatch({ type: "switchTask", botId: bot.id, threadId: target.threadId });
}

export interface ThreadTarget {
  botId: string;
  threadId: string;
}

interface ThreadOpeningState extends NotificationRoutingState {
  bots: Array<NotificationThreadOwner & { name: string }>;
}

export function openThread(
  dispatch: (action: Action) => void,
  target: ThreadTarget,
  state: ThreadOpeningState,
): boolean {
  const owns = (owner: NotificationThreadOwner) =>
    owner.threadId === target.threadId || (owner.tasks ?? []).some((task) => task.threadId === target.threadId);
  if (state.groups.some(owns) || state.bots.some(owns)) {
    openNotificationTarget(dispatch, target, state);
    dispatch({ type: "revealThread", threadId: target.threadId });
    return true;
  }
  const bot = state.bots.find((candidate) => candidate.id === target.botId);
  if (bot) dispatch({ type: "select", id: bot.id });
  dispatch({ type: "notice", notice: { kind: "thread-gone", botName: bot?.name ?? null } });
  return false;
}

function bumpTranscriptGeneration(state: AppState, threadId: string | undefined | null): AppState {
  if (!threadId) return state;
  return {
    ...state,
    transcriptGeneration: {
      ...state.transcriptGeneration,
      [threadId]: (state.transcriptGeneration[threadId] ?? 0) + 1,
    },
  };
}

function updateBot(state: AppState, botId: string, fn: (b: Bot) => Bot): AppState {
  return { ...state, bots: state.bots.map((b) => (b.id === botId ? fn(b) : b)) };
}

function withMascotMotion(
  state: AppState,
  botId: string,
  kind: Exclude<DogMotion, "none">,
): AppState {
  return {
    ...state,
    mascotMotion: {
      botId,
      nonce: (state.mascotMotion?.nonce ?? 0) + 1,
      kind,
    },
  };
}

function withPatchedCard(messages: Message[], messageId: string, patch: Partial<OptionCardData>): Message[] {
  return messages.map((m) => (m.id === messageId && m.card ? { ...m, card: { ...m.card, ...patch } } : m));
}

function patchCard(state: AppState, botId: string, messageId: string, patch: Partial<OptionCardData>): AppState {
  return updateBot(state, botId, (b) => ({ ...b, messages: withPatchedCard(b.messages, messageId, patch) }));
}

function patchGroupCard(state: AppState, groupId: string, messageId: string, patch: Partial<OptionCardData>): AppState {
  return {
    ...state,
    groups: state.groups.map((g) =>
      g.id === groupId ? { ...g, messages: withPatchedCard(g.messages, messageId, patch) } : g,
    ),
  };
}

function openOnboardingCard(bot: Bot): Message | undefined {
  return bot.messages.find(
    (message) => message.kind === "options" && message.card && !message.card.requestId && !message.card.dismissed,
  );
}

function dismissOnboardingCard(state: AppState, botId: string): AppState {
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const quiz = bot ? openOnboardingCard(bot) : undefined;
  return quiz ? patchCard(state, botId, quiz.id, { dismissed: true }) : state;
}

const optimisticMessageId = (sendId: string): string => `optimistic-${sendId}`;

function optimisticUserMessage(
  text: string,
  sendId: string,
  replyToId?: string,
  parentId?: string | null,
  channelMode?: "chat" | "goal",
): Message {
  return {
    id: optimisticMessageId(sendId),
    role: "user",
    kind: "text",
    text,
    at: Date.now(),
    parentId: parentId ?? null,
    replyToId,
    sendId,
    channelMode,
  };
}

export const CLOUD_LINK_SETTINGS = { type: "toggleAppSettings", open: true, section: "general" } as const satisfies Action;

export function reducer(state: AppState, action: Action): AppState {
  if (action.type === "messageAdded" || action.type === "messagePatched" || action.type === "threadActive" || action.type === "optimisticMessageRemoved") {
    const owner = state.bots.find((bot) => (bot.threadId !== action.threadId || bot.awaitingThreadSnapshot) && bot.tasks?.some((task) => task.threadId === action.threadId));
    if (owner) {
      const frames = [...(state.backgroundThreadEvents[action.threadId] ?? []), action].slice(-256);
      const buffered = { ...state, backgroundThreadEvents: { ...state.backgroundThreadEvents, [action.threadId]: frames } };
      return action.type === "messageAdded"
        ? bumpThreadUpdatedAt(buffered, action.threadId, action.message.at)
        : buffered;
    }
  }
  switch (action.type) {
    case "hydrate": {
      const known = (id: string) => action.bots.some((b) => b.id === id) || action.groups.some((g) => g.id === id);
      const selectedId =
        state.selectedId && known(state.selectedId) ? state.selectedId : (action.bots[0]?.id ?? "");
      const hydrated = {
        ...state,
        hydrated: true,
        bots: action.bots.map((bot) => {
          const previous = state.bots.find((candidate) => candidate.id === bot.id);
          return previous ? { ...bot, tasks: mergeTaskStamps(previous.tasks, bot.tasks) } : bot;
        }),
        groups: action.groups.map((group) => {
          const previous = state.groups.find((candidate) => candidate.id === group.id);
          return previous ? { ...group, tasks: mergeTaskStamps(previous.tasks, group.tasks) } : group;
        }),
        sections: action.sections ?? [],
        computerControl: action.computerControl,
        selectedId,
        backgroundThreadEvents: {},
        loadingOlder: {},
        transcriptGeneration: {},
        modelVariantSessions: {},
      };
      return reconcileSnapshotQueues(
        action.botQueuedMessages ? replaceBotQueues(hydrated, action.botQueuedMessages) : hydrated,
        [...action.bots, ...action.groups],
      );
    }
    case "loadOlderMessages":
      return state.loadingOlder[action.threadId]
        ? state
        : { ...state, loadingOlder: { ...state.loadingOlder, [action.threadId]: true } };
    case "olderMessages": {
      const { [action.threadId]: _done, ...loadingOlder } = state.loadingOlder;
      if ((state.transcriptGeneration[action.threadId] ?? 0) !== action.generation) {
        return { ...state, loadingOlder };
      }
      const prepend = <T extends { messages: Message[]; threadId: string; hasMore?: boolean }>(owner: T): T => {
        const held = new Set(owner.messages.map((message) => message.id));
        return {
          ...owner,
          messages: [...action.messages.filter((message) => !held.has(message.id)), ...owner.messages],
          hasMore: action.hasMore,
        };
      };
      return {
        ...state,
        loadingOlder,
        bots: state.bots.map((bot) => (bot.threadId === action.threadId ? prepend(bot) : bot)),
        groups: state.groups.map((group) => (group.threadId === action.threadId ? prepend(group) : group)),
      };
    }
    case "sectionDeleted":
      return {
        ...state, sections: action.sections,
        bots: state.bots.map(bot => bot.section === action.section ? { ...bot, section: undefined } : bot),
        groups: state.groups.map(group => group.section === action.section ? { ...group, section: undefined } : group),
      };
    case "sections":
      return { ...state, sections: action.sections };
    case "botQueues":
      return reconcileSnapshotQueues(replaceBotQueues(state, action.queues), [...state.bots, ...state.groups]);
    case "showWorkspace":
      return { ...state, activeView: "workspace", settingsOpen: false, computerOpen: false, inspectorOpen: false, activityOpen: false };
    case "showChat":
      return state.activeView === "chat" ? state : { ...state, activeView: "chat" };
    case "showTeamMap":
      return {
        ...state,
        activeView: "team-map",
        settingsOpen: false,
        computerOpen: false,
        inspectorOpen: false,
        activityOpen: false,
        appSettingsOpen: false,
        pluginsOpen: false,
        triggersOpen: false,
      };
    case "routinesHydrated":
      return { ...state, routines: action.routines, routineRuns: trimRoutineRuns(action.runs), routinesLoadState: "ready" };
    case "routinesLoadFailed":
      return { ...state, routinesLoadState: "error" };
    case "routinePatched": {
      const exists = state.routines.some((routine) => routine.id === action.routine.id);
      return {
        ...state,
        routines: exists
          ? state.routines.map((routine) => (routine.id === action.routine.id ? action.routine : routine))
          : [action.routine, ...state.routines],
      };
    }
    case "routineDeleted":
      return { ...state, routines: state.routines.filter((routine) => routine.id !== action.routineId) };
    case "routineRunPatched": {
      const exists = state.routineRuns.some((run) => run.id === action.run.id);
      const runs = exists
        ? state.routineRuns.map((run) => (run.id === action.run.id ? action.run : run))
        : [action.run, ...state.routineRuns];
      return {
        ...state,
        routineRuns: trimRoutineRuns(runs),
      };
    }
    case "webhooksHydrated":
      return { ...state, webhooks: action.webhooks, webhookAttempts: action.attempts, webhookIngress: action.ingress };
    case "webhookPatched": {
      const exists = state.webhooks.some((webhook) => webhook.id === action.webhook.id);
      return {
        ...state,
        webhooks: exists
          ? state.webhooks.map((webhook) => (webhook.id === action.webhook.id ? action.webhook : webhook))
          : [action.webhook, ...state.webhooks],
      };
    }
    case "webhookDeleted":
      return {
        ...state,
        webhooks: state.webhooks.filter((webhook) => webhook.id !== action.webhookId),
        webhookAttempts: state.webhookAttempts.filter((attempt) => attempt.webhookId !== action.webhookId),
      };
    case "webhookAttempted": {
      const attempts = state.webhookAttempts.some((attempt) => attempt.id === action.attempt.id)
        ? state.webhookAttempts.map((attempt) => attempt.id === action.attempt.id ? action.attempt : attempt)
        : [...state.webhookAttempts, action.attempt];
      return { ...state, webhookAttempts: attempts.slice(-2_000) };
    }
    case "groupPatched": {
      const fenced = action.group.messages ? bumpTranscriptGeneration(state, action.group.threadId) : state;
      const exists = fenced.groups.some((g) => g.id === action.group.id);
      const groups = exists
        ? fenced.groups.map((g) => (g.id === action.group.id ? {
            ...g, ...action.group,
            section: typeof action.group.threadId === "string" || Object.hasOwn(action.group, "section") ? action.group.section : g.section,
            tasks: action.group.tasks ? mergeTaskStamps(g.tasks, action.group.tasks) : g.tasks,
            turnTimeoutMinutes: Object.hasOwn(action.group, "turnTimeoutMinutes")
              ? (action.group.turnTimeoutMinutes ?? undefined)
              : g.turnTimeoutMinutes,
            messages: action.group.messages ?? g.messages,
            hasMore: action.group.messages ? Boolean(action.group.hasMore) : g.hasMore,
          } : g))
        : [{ ...(action.group as Group), messages: action.group.messages ?? [] }, ...fenced.groups];
      return { ...fenced, groups };
    }
    case "groupDeleted": {
      const groups = state.groups.filter((g) => g.id !== action.groupId);
      const selectedId = state.selectedId === action.groupId ? (state.bots[0]?.id ?? "") : state.selectedId;
      return { ...state, groups, selectedId };
    }
    case "instances":
      return { ...state, instances: action.instances };
    case "configStatus":
      return { ...state, config: action.config };
    case "liveCall":
      return { ...state, liveCall: action.call, liveCallVersion: state.liveCallVersion + 1 };
    case "liveCallLookup":
      return action.since === state.liveCallVersion && action.seq > state.liveCallLookupSeq
        ? { ...state, liveCall: action.call, liveCallLookupSeq: action.seq }
        : state;
    case "profileSaved":
      return state.config ? {
        ...state,
        config: { ...state.config, profile: { name: "", email: "", ...state.config.profile, ...action.profile } },
      } : state;
    case "select": {
      if (state.groups.some((g) => g.id === action.id)) {
        return {
          ...state,
          activeView: "chat",
          selectedId: action.id,
          botSettingsSection: action.id !== state.selectedId ? "overview" : state.botSettingsSection,
          groups: state.groups.map((g) => (g.id === action.id ? { ...g, unread: false } : g)),
        };
      }
      return updateBot(
        withMascotMotion(
          {
            ...state,
            activeView: "chat",
            selectedId: action.id,
            botSettingsSection: action.id !== state.selectedId ? "overview" : state.botSettingsSection,
          },
          action.id,
          "switch",
        ),
        action.id,
        (b) => ({ ...b, unread: Boolean(b.tasks?.some((task) => task.threadId !== b.threadId && task.unread)), tasks: b.tasks?.map((task) => task.threadId === b.threadId ? { ...task, unread: false } : task) }),
      );
    }
    case "giveTreat":
      return withMascotMotion(state, action.botId, "celebrate");
    case "answerCard": {
      if (action.groupId) return patchGroupCard(state, action.groupId, action.messageId, { answered: action.answer });
      const bot = state.bots.find((candidate) => candidate.id === action.botId);
      const card = bot?.messages.find((message) => message.id === action.messageId)?.card;
      return withMascotMotion(
        patchCard(state, action.botId, action.messageId, {
          answered: action.answer,
          ...(card?.requestId ? {} : { dismissed: true }),
        }),
        action.botId,
        "working",
      );
    }
    case "dismissCard":
      if (action.groupId) return patchGroupCard(state, action.groupId, action.messageId, { dismissed: true });
      return patchCard(state, action.botId, action.messageId, { dismissed: true });
    case "decideRequest":
      return state;
    case "botAdded":
      return withMascotMotion({
        ...state,
        bots: [action.bot, ...state.bots.filter((bot) => bot.id !== action.bot.id)],
        ...(action.preserveSelection ? {} : { activeView: "chat" as const, selectedId: action.bot.id }),
      }, action.bot.id, "arrive");
    case "deleteBot": {
      const bots = state.bots.filter((b) => b.id !== action.botId);
      const selectedId =
        state.selectedId === action.botId ? (bots.find((b) => !b.hidden)?.id ?? bots[0]?.id ?? "") : state.selectedId;
      const { [action.botId]: _deleted, ...deletingBots } = state.deletingBots;
      return reconcileModelVariantSessions({ ...state, bots, selectedId, deletingBots });
    }
    case "botDeletionPending": {
      if (action.on) {
        if (state.deletingBots[action.botId]) return state;
        return { ...state, deletingBots: { ...state.deletingBots, [action.botId]: true } };
      }
      if (!state.deletingBots[action.botId]) return state;
      const { [action.botId]: _settled, ...deletingBots } = state.deletingBots;
      return { ...state, deletingBots };
    }
    case "markUnread":
      return updateBot(withMascotMotion(state, action.botId, "surprise"), action.botId, (b) => ({ ...b, unread: true }));
    case "botPatched": {
      const before = state.bots.find((b) => b.id === action.bot.id);
      if (!before) {
        const added = {
          ...state,
          bots: [{ ...action.bot, messages: action.bot.messages ?? [] }, ...state.bots],
        };
        return reconcileSnapshotQueues(added, [action.bot]);
      }
      const kind =
        action.bot.unread && !before?.unread
          ? "surprise"
          : action.bot.busy === true && !before?.busy
            ? "working"
            : action.bot.busy === false && before?.busy
              ? "celebrate"
              : null;
      const motioned = kind ? withMascotMotion(state, action.bot.id, kind) : state;
      const animated = action.bot.busy === false && before?.busy && motioned.computerStarts[action.bot.id]
        ? reducer(motioned, { type: "computerStart", botId: action.bot.id, start: null }) : motioned;
      const next = action.bot.chiefOfStaff
        ? {
            ...animated,
            bots: animated.bots.map((b) =>
              b.id === action.bot.id || (b.section?.trim() || "") !== (action.bot.section?.trim() || "")
                ? b
                : { ...b, chiefOfStaff: false },
            ),
          }
        : animated;
      const switchedThread =
        typeof action.bot.threadId === "string" && action.bot.threadId !== before.threadId &&
        !action.bot.tasks?.some((task) => task.threadId === before.threadId);
      let switching = next;
      if (switchedThread) {
        const { [action.bot.threadId]: _stale, ...otherThreadEvents } = next.backgroundThreadEvents;
        switching = { ...next, backgroundThreadEvents: otherThreadEvents };
      }
      if ((switchedThread || (before.awaitingThreadSnapshot && action.bot.threadId === before.threadId)) &&
          Array.isArray(action.bot.messages)) {
        return reducer(switching, { type: "taskSwitched", bot: { ...before, ...action.bot, computer: action.bot.computer, section: action.bot.section, toolScope: action.bot.toolScope, messages: action.bot.messages, browserProfile: action.bot.browserProfile } });
      }
      const patched = updateBot(switching, action.bot.id, (b) => ({
        ...b,
        ...action.bot,
        threadId: switchedThread ? action.bot.threadId : b.threadId,
        activeLeafId: switchedThread ? null : b.activeLeafId,
        awaitingThreadSnapshot: switchedThread || b.awaitingThreadSnapshot,
        browserProfile: action.bot.browserProfile,
        computer: action.bot.computer,
        toolScope: action.bot.toolScope,
        section: action.bot.section,
        tasks: action.bot.tasks ? mergeTaskStamps(b.tasks, action.bot.tasks) : b.tasks,
        messages: switchedThread ? [] : b.messages,
        hasMore: switchedThread ? undefined : b.hasMore,
      }));
      return reconcileModelVariantSessions(patched);
    }
    case "messageAdded": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) {
        const group = state.groups.find((g) => g.threadId === action.threadId || g.tasks?.some((task) => task.threadId === action.threadId));
        if (!group) return state;
        if (group.threadId === action.threadId && group.messages.some((m) => m.id === action.message.id)) return state;
        const stamped = bumpThreadUpdatedAt(state, action.threadId, action.message.at);
        if (group.threadId !== action.threadId) return stamped;
        const optimisticIndex = action.message.sendId
          ? group.messages.findIndex(
              (message) => message.id === optimisticMessageId(action.message.sendId!),
            )
          : -1;
        return {
          ...stamped,
          groups: stamped.groups.map((g) =>
            g.id === group.id
              ? {
                  ...g,
                  messages: optimisticIndex >= 0
                    ? g.messages.map((message, index) =>
                        index === optimisticIndex ? action.message : message
                      )
                    : [...g.messages, action.message],
                }
              : g,
          ),
        };
      }
      if (bot.messages.some((message) => message.id === action.message.id)) return state;
      const stamped = bumpThreadUpdatedAt(state, action.threadId, action.message.at);
      const optimisticId = action.message.sendId
        ? optimisticMessageId(action.message.sendId)
        : null;
      const optimisticIndex = optimisticId
        ? bot.messages.findIndex((message) => message.id === optimisticId)
        : -1;
      if (optimisticIndex >= 0) {
        return updateBot(stamped, bot.id, (current) => ({
          ...current,
          messages: current.messages.map((message, index) =>
            index === optimisticIndex ? action.message : message
          ),
          activeLeafId: current.activeLeafId === optimisticId
            ? action.message.id
            : current.activeLeafId,
        }));
      }
      const next = updateBot(stamped, bot.id, (b) => {
        const parent = action.message.parentId ?? null;
        const leaf = b.activeLeafId ?? null;
        const adoptsLeaf = parent === leaf || (leaf !== null && descendsFrom(b.messages, parent, leaf));
        return { ...b, messages: [...b.messages, action.message], activeLeafId: adoptsLeaf ? action.message.id : b.activeLeafId };
      });
      const motion =
        action.message.role === "user" && action.message.kind === "text" && Boolean(action.message.queueId)
          ? "working"
          : action.message.kind === "options"
          ? "thinking"
          : action.message.kind === "activity"
            ? action.message.tool?.ok === false
              ? "failure"
              : action.message.tool?.ok === true
                ? "success"
                : "working"
            : action.message.role === "bot" && action.message.kind === "text"
              ? "blink"
              : null;
      const animated = motion ? withMascotMotion(next, bot.id, motion) : next;
      return animated;
    }
    case "optimisticMessageRemoved": {
      const id = optimisticMessageId(action.sendId);
      const bot = state.bots.find((candidate) => candidate.threadId === action.threadId);
      if (bot) {
        const optimistic = bot.messages.find((message) => message.id === id);
        if (!optimistic) return state;
        const cleared = updateBot(state, bot.id, (current) => {
          const messages = current.messages.filter((message) => message.id !== id);
          const restored = action.restoreLeafId !== undefined ? action.restoreLeafId : (optimistic.parentId ?? null);
          return {
            ...current,
            messages,
            activeLeafId: current.activeLeafId === id ? newestTip(messages, restored) : current.activeLeafId,
          };
        });
        const task = bot.tasks?.find((candidate) => candidate.threadId === action.threadId);
        const kept = cleared.bots.find((candidate) => candidate.id === bot.id)?.messages ?? [];
        return rewindThreadUpdatedAt(cleared, action.threadId, kept, task?.createdAt ?? 0);
      }
      const group = state.groups.find((candidate) => candidate.threadId === action.threadId);
      if (!group || !group.messages.some((message) => message.id === id)) return state;
      const cleared = {
        ...state,
        groups: state.groups.map((candidate) => candidate.id === group.id
          ? { ...candidate, messages: candidate.messages.filter((message) => message.id !== id) }
          : candidate),
      };
      const task = group.tasks?.find((candidate) => candidate.threadId === action.threadId);
      const kept = cleared.groups.find((candidate) => candidate.id === group.id)?.messages ?? [];
      return rewindThreadUpdatedAt(cleared, action.threadId, kept, task?.createdAt ?? group.createdAt);
    }
    case "messagePatched": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) {
        const group = state.groups.find((g) => g.threadId === action.threadId);
        if (!group) return state;
        return {
          ...state,
          groups: state.groups.map((g) =>
            g.id === group.id
              ? { ...g, messages: g.messages.map((m) => (m.id === action.message.id ? action.message : m)) }
              : g,
          ),
        };
      }
      const motion =
        action.message.kind === "activity"
          ? action.message.tool?.ok === false
            ? "failure"
            : action.message.tool?.ok === true
              ? "success"
              : "working"
          : null;
      const next = motion ? withMascotMotion(state, bot.id, motion) : state;
      return updateBot(next, bot.id, (b) => ({
        ...b,
        messages: b.messages.map((m) => (m.id === action.message.id ? action.message : m)),
      }));
    }
    case "computerStart": {
      const { [action.botId]: _ended, ...others } = state.computerStarts;
      return {
        ...(action.start ? withMascotMotion(state, action.botId, "launch") : state),
        computerStarts: action.start ? { ...others, [action.botId]: action.start } : others,
      };
    }
    case "computerControl":
      return {
        ...state,
        computerControl: {
          ...state.computerControl,
          [action.botId]: { held: action.held, helpReason: action.helpReason },
        },
      };
    case "takeoverIntent":
      return state.takeoverIntent === action.intent ? state : { ...state, takeoverIntent: action.intent };
    case "modelVariantRuntime": {
      const event = action.event;
      if (!event.turnId) return state;
      const owner = state.bots.find((bot) => bot.threadId === event.threadId || bot.tasks?.some((task) => task.threadId === event.threadId));
      if (!owner) return state;
      const selection = currentTaskBot(owner, event.threadId).modelSelection;
      if (selection.instanceId !== event.providerInstanceId ||
          !state.instances.find((instance) => instance.instanceId === selection.instanceId)?.capabilities?.modelVariants) return state;
      const previous = state.modelVariantSessions[event.threadId];
      if (event.type === "turn.started") {
        if (previous && (previous.turnId === event.turnId || Date.parse(previous.startedAt) > Date.parse(event.createdAt))) return state;
        return { ...state, modelVariantSessions: { ...state.modelVariantSessions, [event.threadId]: {
          instanceId: selection.instanceId, model: selection.model, turnId: event.turnId, startedAt: event.createdAt, acceptingUpdates: true,
        } } };
      }
      if (!previous?.acceptingUpdates || previous.turnId !== event.turnId || previous.instanceId !== selection.instanceId || previous.model !== selection.model) return state;
      if (event.type === "session.model-variants" && event.model === selection.model) {
        return { ...state, modelVariantSessions: { ...state.modelVariantSessions, [event.threadId]: { ...previous, variants: event.variants } } };
      }
      if (event.type === "turn.completed") {
        return { ...state, modelVariantSessions: { ...state.modelVariantSessions, [event.threadId]: { ...previous, acceptingUpdates: false } } };
      }
      return state;
    }
    case "setModel":
      if (action.threadId) {
        const picked = reducer(state, { type: "updateTask", botId: action.botId, threadId: action.threadId,
          patch: { modelSelection: action.selection, resetApprovalToAsk: action.resetApprovalToAsk } });
        return updateBot(picked, action.botId, (bot) => ({ ...bot, tasks: bot.tasks?.map((task) => task.threadId !== action.threadId ? task
          : { ...task, followsBotModel: Boolean(action.updateBotDefault) || sameModelSelection(action.selection, bot.modelSelection) }) }));
      }
      return reconcileModelVariantSessions(updateBot(state, action.botId, (b) => ({ ...b, modelSelection: action.selection })));
    case "updateTask": {
      const patch = taskPatchFields(action.patch);
      return reconcileModelVariantSessions(updateBot(state, action.botId, (bot) => ({
        ...bot,
        tasks: (bot.tasks ?? [{ threadId: bot.threadId, title: "New thread", createdAt: Date.now() }]).map((task) =>
          task.threadId === action.threadId ? { ...task, ...patch } : task),
      })));
    }
    case "connected":
      return { ...state, connected: action.value };
    case "error":
      return {
        ...(action.message && state.selectedId
          ? withMascotMotion(state, state.selectedId, "alert")
          : state),
        error: action.message,
      };
    case "toggleSettings": {
      if (action.botId !== undefined && !state.bots.some((bot) => bot.id === action.botId && !bot.hidden)) return state;
      const selectedId = action.botId ?? state.selectedId;
      const open = action.open ?? (action.botId !== undefined || !state.settingsOpen);
      return {
        ...state,
        selectedId,
        settingsOpen: open,
        activityOpen: open ? false : state.activityOpen,
        botSettingsSection: action.section ?? (selectedId !== state.selectedId ? "overview" : state.botSettingsSection),
        botSettingsExpandAccordion: open ? action.section !== undefined : false,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "togglePlugins": {
      const open = action.open ?? !state.pluginsOpen;
      return {
        ...state,
        pluginsOpen: open,
        pluginsSurface: action.surface ?? state.pluginsSurface,
        ...(open ? { settingsOpen: false, appSettingsOpen: false, newBotOpen: false, shortcutsOpen: false, triggersOpen: false } : {}),
      };
    }
    case "toggleTriggers": {
      const open = action.open ?? !state.triggersOpen;
      return {
        ...state,
        triggersOpen: open,
        ...(open ? { settingsOpen: false, appSettingsOpen: false, newBotOpen: false, shortcutsOpen: false, pluginsOpen: false } : {}),
      };
    }
    case "botCreationPending":
      return { ...state, botCreationPending: action.on };
    case "toggleNewBot": {
      const open = action.open ?? !state.newBotOpen;
      return {
        ...state, newBotOpen: open,
        ...(open ? { settingsOpen: false, appSettingsOpen: false, pluginsOpen: false, shortcutsOpen: false, triggersOpen: false } : {}),
      };
    }
    case "notice":
      return { ...state, notice: action.notice };
    case "revealThread":
      return { ...state, revealThread: { threadId: action.threadId, nonce: (state.revealThread?.nonce ?? 0) + 1 } };
    case "focusMessage":
      return {
        ...state,
        focusMessage: {
          threadId: action.threadId,
          messageId: action.messageId,
          matchText: action.matchText,
          nonce: (state.focusMessage?.nonce ?? 0) + 1,
          consumed: false,
        },
      };
    case "focusMessageConsumed":
      if (!state.focusMessage || state.focusMessage.nonce !== action.nonce) return state;
      return { ...state, focusMessage: { ...state.focusMessage, consumed: true } };
    case "openCloudTask":
      return {
        ...state,
        computerOpen: true,
        cloudTaskId: action.jobId,
        settingsOpen: false,
        inspectorOpen: false,
        activityOpen: false,
        appSettingsOpen: false,
      };
    case "closeCloudTask":
      return state.cloudTaskId === null ? state : { ...state, cloudTaskId: null };
    case "toggleComputer": {
      const open = action.open ?? !state.computerOpen;
      return {
        ...state,
        computerOpen: open,
        cloudTaskId: null,
        takeoverIntent: open ? state.takeoverIntent : null,
        settingsOpen: open ? false : state.settingsOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        activityOpen: open ? false : state.activityOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "toggleInspector": {
      const open = action.open ?? !state.inspectorOpen;
      return {
        ...state,
        inspectorOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        activityOpen: open ? false : state.activityOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "toggleActivity": {
      const open = action.open ?? !state.activityOpen;
      return {
        ...state,
        activityOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "toggleAppSettings": {
      const open = action.open ?? !state.appSettingsOpen;
      return {
        ...state,
        appSettingsOpen: open,
        activityOpen: open ? false : state.activityOpen,
        appSettingsSection: action.section ?? state.appSettingsSection,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        pluginsOpen: open ? false : state.pluginsOpen,
        triggersOpen: open ? false : state.triggersOpen,
      };
    }
    case "toggleShortcuts": {
      const open = action.open ?? !state.shortcutsOpen;
      return {
        ...state,
        shortcutsOpen: open,
      };
    }
    case "toggleTour": {
      const open = action.open ?? !state.tourOpen;
      return { ...state, tourOpen: open, appSettingsOpen: open ? false : state.appSettingsOpen };
    }
    case "toggleWelcome": {
      const open = action.open ?? !state.welcomeOpen;
      return {
        ...state,
        welcomeOpen: open,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        shortcutsOpen: open ? false : state.shortcutsOpen,
      };
    }
    case "updateBot": {
      const mascotChanged =
        Object.prototype.hasOwnProperty.call(action.patch, "color") ||
        Object.prototype.hasOwnProperty.call(action.patch, "mascotExpression");
      const animated = mascotChanged
        ? withMascotMotion(state, action.botId, "customize")
        : state;
      const target = animated.bots.find((bot) => bot.id === action.botId);
      const chiefSection = (action.patch.section ?? target?.section)?.trim() || "";
      const next = action.patch.chiefOfStaff
        ? {
            ...animated,
            bots: animated.bots.map((b) =>
              b.id === action.botId || (b.section?.trim() || "") !== chiefSection
                ? b
                : { ...b, chiefOfStaff: false },
            ),
          }
        : animated;
      const {
        acknowledgeLocalAuto: _localAck,
        confirmFullAccess: _fullConfirmation,
        applyToAllThreads: _allThreads,
        computer,
        connectorTools,
        connectorScopes,
        ...rest
      } = action.patch;
      const botPatch: Partial<Bot> = { ...rest };
      if (computer === null) botPatch.computer = undefined;
      else if (computer !== undefined) botPatch.computer = computer;
      if (connectorTools === null) botPatch.connectorTools = undefined;
      else if (connectorTools !== undefined) botPatch.connectorTools = connectorTools;
      if (connectorScopes === null) botPatch.connectorScopes = undefined;
      else if (connectorScopes !== undefined) botPatch.connectorScopes = connectorScopes;
      return updateBot(next, action.botId, (b) => ({ ...b, ...botPatch }));
    }
    case "threadActive": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      return updateBot(bumpTranscriptGeneration(state, action.threadId), bot.id, (b) => ({
        ...b,
        activeLeafId: action.activeLeafId,
      }));
    }
    case "switchBranch": {
      const bot = state.bots.find((b) => b.id === action.botId);
      if (!bot) return state;
      let cur = action.messageId;
      for (;;) {
        const children = bot.messages.filter((m) => m.parentId === cur);
        if (!children.length) break;
        cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
      }
      return updateBot(bumpTranscriptGeneration(state, bot.threadId), action.botId, (b) => ({ ...b, activeLeafId: cur }));
    }
    case "patchGroup":
      return {
        ...state,
        groups: state.groups.map((g) => (g.id === action.groupId ? { ...g, ...action.patch } : g)),
      };
    case "pendingQueued": {
      if (state.consumedQueueIds[action.queueId]) {
        const consumedQueueIds = { ...state.consumedQueueIds };
        delete consumedQueueIds[action.queueId];
        return { ...state, consumedQueueIds };
      }
      const prev = state.pendingQueued[action.threadId] ?? [];
      if (prev.some((entry) => entry.queueId === action.queueId)) return state;
      return {
        ...state,
        pendingQueued: {
          ...state.pendingQueued,
          [action.threadId]: [...prev, { queueId: action.queueId, text: action.text, ...(action.reason ? { reason: action.reason } : {}) }],
        },
      };
    }
    case "consumePendingQueued": {
      const prev = state.pendingQueued[action.threadId] ?? [];
      const at = prev.findIndex((entry) => entry.queueId === action.queueId);
      if (at < 0) {
        return {
          ...state,
          consumedQueueIds: rememberConsumedQueueId(state.consumedQueueIds, action.queueId),
        };
      }
      const rest = prev.filter((_, i) => i !== at);
      const pendingQueued = { ...state.pendingQueued };
      if (rest.length) pendingQueued[action.threadId] = rest;
      else delete pendingQueued[action.threadId];
      return { ...state, pendingQueued, consumedQueueIds: rememberConsumedQueueId(state.consumedQueueIds, action.queueId) };
    }
    case "cancelQueued": {
      const bot = state.bots.find((candidate) => candidate.id === action.botId);
      if (!bot) return state;
      const threadId = action.threadId ?? bot.threadId;
      const prev = state.pendingQueued[threadId] ?? [];
      const rest = prev.filter((entry) => entry.queueId !== action.queueId);
      const pendingQueued = { ...state.pendingQueued };
      if (rest.length) pendingQueued[threadId] = rest;
      else delete pendingQueued[threadId];
      return { ...state, pendingQueued, consumedQueueIds: rememberConsumedQueueId(state.consumedQueueIds, action.queueId) };
    }
    case "steerQueued":
      return state;
    case "cancelGroupQueued": {
      const prev = state.pendingQueued[action.threadId] ?? [];
      const rest = prev.filter((entry) => entry.queueId !== action.queueId);
      if (rest.length === prev.length) return state;
      const pendingQueued = { ...state.pendingQueued };
      if (rest.length) pendingQueued[action.threadId] = rest;
      else delete pendingQueued[action.threadId];
      return { ...state, pendingQueued };
    }
    case "send": {
      const animated = withMascotMotion(
        dismissOnboardingCard(state, action.botId),
        action.botId,
        "working",
      );
      if (!action.sendId) return animated;
      const bot = animated.bots.find((candidate) => candidate.id === action.botId);
      const threadId = action.threadId ?? bot?.threadId;
      if (!bot || threadId !== bot.threadId) return animated;
      if (bot.messages.some((message) => message.sendId === action.sendId)) return animated;
      const message = optimisticUserMessage(
        action.text,
        action.sendId,
        action.replyToId,
        bot.activeLeafId,
      );
      return bumpThreadUpdatedAt(updateBot(animated, bot.id, (current) => ({
        ...current,
        messages: [...current.messages, message],
        activeLeafId: message.id,
      })), threadId, message.at);
    }
    case "editMessage": {
      const animated = withMascotMotion(state, action.botId, "working");
      if (!action.sendId) return animated;
      const bot = animated.bots.find((candidate) => candidate.id === action.botId);
      const threadId = action.threadId ?? bot?.threadId;
      if (!bot || threadId !== bot.threadId) return animated;
      if (bot.messages.some((message) => message.sendId === action.sendId)) return animated;
      const source = bot.messages.find((message) => message.id === action.messageId);
      if (!source || source.role !== "user" || source.kind !== "text") return animated;
      const message = optimisticUserMessage(
        action.text.trim(),
        action.sendId,
        source.replyToId,
        source.parentId ?? null,
      );
      return updateBot(animated, bot.id, (current) => ({
        ...current,
        messages: [...current.messages, message],
        activeLeafId: message.id,
      }));
    }
    case "deleteTask":
    case "newGroupTask":
    case "switchGroupTask":
    case "deleteGroupTask":
    case "regenerateTaskTitle":
      return state;
    case "newTask":
      return { ...state, selectedId: action.botId, activeView: "chat" };
    case "switchTask": {
      const { [action.threadId]: _old, ...backgroundThreadEvents } = state.backgroundThreadEvents;
      return { ...state, backgroundThreadEvents, selectedId: action.botId, activeView: "chat" };
    }
    case "renameTask":
      return updateBot(state, action.botId, (bot) => ({
        ...bot,
        tasks: (bot.tasks ?? []).map((task) =>
          task.threadId === action.threadId ? { ...task, title: action.title } : task,
        ),
      }));
    case "renameGroupTask":
      return {
        ...state,
        groups: state.groups.map((group) =>
          group.id === action.groupId
            ? {
                ...group,
                tasks: (group.tasks ?? []).map((task) =>
                  task.threadId === action.threadId ? { ...task, title: action.title } : task,
                ),
              }
            : group,
        ),
      };
    case "pinGroupTask":
      return {
        ...state,
        groups: state.groups.map((group) =>
          group.id === action.groupId
            ? {
                ...group,
                tasks: (group.tasks ?? []).map((task) =>
                  task.threadId === action.threadId ? { ...task, pinned: action.pinned ? true : undefined } : task,
                ),
              }
            : group,
        ),
      };
    case "setConversationTurnLimit":
      return {
        ...state,
        groups: state.groups.map((group) => {
          if (group.id !== action.groupId) return group;
          if (action.dm) return { ...group, turnTimeoutMinutes: action.minutes ?? undefined };
          return {
            ...group,
            tasks: (group.tasks ?? []).map((task) =>
              task.threadId === action.threadId
                ? { ...task, turnTimeoutMinutes: action.minutes ?? undefined }
                : task,
            ),
          };
        }),
      };
    case "taskSwitched": {
      let switched = updateBot(bumpTranscriptGeneration(state, action.bot.threadId), action.bot.id, (bot) => ({
        ...bot,
        ...action.bot,
        computer: action.bot.computer,
        toolScope: action.bot.toolScope,
        messages: action.bot.messages ?? [],
        hasMore: action.bot.hasMore,
        awaitingThreadSnapshot: false,
      }));
      for (const frame of state.backgroundThreadEvents[action.bot.threadId] ?? []) switched = reducer(switched, frame);
      const { [action.bot.threadId]: _settled, ...backgroundThreadEvents } = switched.backgroundThreadEvents;
      switched = { ...switched, backgroundThreadEvents };
      return reconcileModelVariantSessions(reconcileSnapshotQueues(switched, [action.bot]));
    }
    case "newBot":
    case "duplicateBot":
    case "createProject":
    case "updateProject":
    case "deleteProject":
    case "reorderProjects":
    case "interrupt":
    case "createGroup":
    case "deleteGroup":
    case "interruptGroup":
    case "steerGroupQueued":
    case "createRoutine":
    case "updateRoutine":
    case "deleteRoutine":
    case "runRoutine":
    case "cancelRoutineRun":
    case "refreshTaskPermissions":
    case "followBotModel":
      return state;
    case "sendGroup": {
      if (!action.sendId) return state;
      const group = state.groups.find((candidate) => candidate.id === action.groupId);
      const threadId = action.threadId ?? group?.threadId;
      if (!group || threadId !== group.threadId) return state;
      if (group.messages.some((message) => message.sendId === action.sendId)) return state;
      const message = optimisticUserMessage(
        action.text,
        action.sendId,
        action.replyToId,
        null,
        action.mode ?? "chat",
      );
      return bumpThreadUpdatedAt({
        ...state,
        groups: state.groups.map((candidate) => candidate.id === group.id
          ? { ...candidate, messages: [...candidate.messages, message] }
          : candidate),
      }, threadId, message.at);
    }
  }
}

export const initialState: AppState = {
  modelVariantSessions: {},
  backgroundThreadEvents: {},
  loadingOlder: {},
  transcriptGeneration: {},
  bots: [],
  groups: [],
  sections: [],
  instances: [],
  config: null,
  liveCall: null,
  liveCallVersion: 0,
  liveCallLookupSeq: 0,
  selectedId: "",
  activeView: "chat",
  routines: [],
  routineRuns: [],
  routinesLoadState: "loading",
  webhooks: [],
  webhookAttempts: [],
  webhookIngress: null,
  settingsOpen: false,
  pluginsOpen: false,
  pluginsSurface: "apps",
  triggersOpen: false,
  newBotOpen: false,
  botCreationPending: false,
  computerOpen: false,
  cloudTaskId: null,
  inspectorOpen: false,
  activityOpen: false,
  appSettingsOpen: false,
  appSettingsSection: "general",
  shortcutsOpen: false,
  welcomeOpen: false,
  tourOpen: false,
  botSettingsSection: "overview",
  botSettingsExpandAccordion: false,
  computerStarts: {},
  deletingBots: {},
  computerControl: {},
  takeoverIntent: null,
  focusMessage: null,
  connected: false,
  error: null,
  notice: null,
  revealThread: null,
  mascotMotion: null,
  pendingQueued: {},
  consumedQueueIds: {},
};

export function liveCallFromFrame(frame: unknown): { call: LiveCallState | null } | null {
  if (!frame || typeof frame !== "object" || !Object.prototype.hasOwnProperty.call(frame, "call")) return null;
  const call: unknown = Reflect.get(frame, "call");
  if (call === null) return { call: null };
  if (!call || typeof call !== "object") return null;
  const record = call as Record<string, unknown>;
  if (typeof record.callId !== "string" || typeof record.botId !== "string" || typeof record.threadId !== "string" || typeof record.status !== "string") {
    return null;
  }
  return { call: call as LiveCallState };
}

let liveCallLookups = 0;
export function nextLiveCallLookup(): number {
  liveCallLookups += 1;
  return liveCallLookups;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body?: Record<string, unknown>;
  constructor(message: string, status: number, body?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export interface NewDogFields {
  avatarUrl?: string | null;
  avatarCrop?: Bot["avatarCrop"];
  name?: string;
  title?: string;
  modelSelection?: ModelSelection;
  visibility?: BotVisibility;
  section?: string;
  offLeash?: boolean;
}

export async function createDog(fields: NewDogFields = {}, request: typeof api = api): Promise<{ bot: Bot }> {
  const name = fields.name?.trim();
  const title = fields.title?.trim();
  const body = {
    ...(name ? { name } : {}),
    ...(title ? { title } : {}),
    ...(fields.modelSelection ? { modelSelection: fields.modelSelection, requireAvailableModel: true } : {}),
    ...(fields.visibility && fields.visibility !== "everyone" ? { visibility: fields.visibility } : {}),
    ...(fields.section !== undefined ? { section: fields.section } : {}),
    ...(fields.offLeash || fields.avatarUrl ? { settings: {
      ...(fields.offLeash ? { approvalMode: "auto" } : {}),
      ...(fields.avatarUrl ? { avatarUrl: fields.avatarUrl, avatarCrop: fields.avatarCrop ?? "circle" } : {}),
    } } : {}),
  };
  const { bot } = await request("/api/bots", {
    method: "POST",
    ...(Object.keys(body).length ? { body: JSON.stringify(body) } : {}),
  });
  return { bot };
}

export function duplicateProfileFor(source: Bot) {
  return {
    name: `${source.name} copy`,
    title: source.title,
    description: source.description,
    soul: source.soul,
    notifications: source.notifications,
    modelSelection: source.modelSelection,
    computer: source.computer,
    cloudBackend: source.cloudBackend,
    autoStartVps: source.autoStartVps,
    color: source.color,
    mascotBody: source.mascotBody,
    avatarUrl: source.avatarUrl,
    avatarCrop: source.avatarCrop,
    avatarZoom: source.avatarZoom,
    avatarFocusX: source.avatarFocusX,
    avatarFocusY: source.avatarFocusY,
  };
}

export const MESSAGE_PAGE_SIZE = 200;

const uncertainSends = new UncertainSends();

export async function api<T = any>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { timeoutMs, signal, ...rest } = init ?? {};
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...rest,
    signal: timeoutMs === undefined
      ? signal
      : signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? statusFallback(res.status), res.status, body);
  return body;
}

type TrustedApprovalBridge = {
  setMode(
    botId: string,
    mode: ApprovalMode,
    options?: { acknowledgeLocalAuto?: boolean; threadId?: string; threadOnly?: boolean; allThreads?: boolean; refreshPermissions?: boolean },
  ): Promise<BotAnnouncement>;
};

export async function persistTaskApproval(
  botId: string, threadId: string, patch: TaskUpdatePatch,
  bridge: TrustedApprovalBridge | undefined,
  request: (path: string, init?: RequestInit) => Promise<{ bot: BotAnnouncement }> = api,
): Promise<BotAnnouncement> {
  const { approvalMode, autoApprove, confirmFullAccess, acknowledgeLocalAuto, ...ordinary } = patch;
  const mode = approvalMode ?? (autoApprove === undefined ? undefined : autoApprove ? "auto" : "ask");
  if (mode === "full" && confirmFullAccess !== true) throw new Error("Confirm Full access for this thread first");
  if ((mode === "full" || mode === "custom") && !bridge) throw new Error("This approval change requires the packaged desktop app");
  if (mode && bridge) {
    if (Object.keys(ordinary).length) await request(`/api/bots/${botId}/tasks/${threadId}`, { method: "PATCH", body: JSON.stringify(ordinary) });
    return bridge.setMode(botId, mode, { threadId, threadOnly: true, acknowledgeLocalAuto: acknowledgeLocalAuto === true });
  }
  const result = await request(`/api/bots/${botId}/tasks/${threadId}`, { method: "PATCH", body: JSON.stringify({ ...ordinary, approvalMode, autoApprove, acknowledgeLocalAuto }) });
  return result.bot;
}

export async function persistBotUpdate(
  botId: string,
  patch: BotUpdatePatch,
  signal: AbortSignal,
  request: (path: string, init?: RequestInit) => Promise<{ bot: BotAnnouncement }> = api,
  trustedApprovals: TrustedApprovalBridge | undefined =
    typeof window === "undefined" ? undefined : window.laterdog?.approvals,
  currentBot?: BotAnnouncement,
): Promise<BotAnnouncement> {
  const {
    approvalMode,
    confirmFullAccess,
    applyToAllThreads,
    ...ordinaryPatch
  } = patch;
  const trustedMode = approvalMode === "full" || approvalMode === "custom"
    ? approvalMode
    : null;
  const leavesCustom = approvalMode !== undefined &&
    approvalModeFor(currentBot ?? {}) === "custom" &&
    approvalMode !== "custom";

  if (!trustedMode && !leavesCustom) {
    const result = await request(`/api/bots/${botId}`, {
      method: "PATCH",
      body: JSON.stringify(
        approvalMode === undefined ? ordinaryPatch : { ...ordinaryPatch, approvalMode },
      ),
      signal,
    });
    return result.bot;
  }

  if (approvalMode === "full" && confirmFullAccess !== true) {
    throw new Error("Confirm the Full access warning before enabling it");
  }
  if (!trustedApprovals || approvalMode === undefined) {
    throw new Error("This approval-level change requires the packaged desktop app");
  }

  const trustedOptions = {
    acknowledgeLocalAuto: ordinaryPatch.acknowledgeLocalAuto === true,
    ...(applyToAllThreads ? { allThreads: true } : {}),
  };

  const rejectCancelledTrustedGrant = async () => {
    if (!signal.aborted) return;
    if (approvalMode === "full" || approvalMode === "custom") {
      try {
        await trustedApprovals.setMode(botId, "ask", { acknowledgeLocalAuto: false, ...(applyToAllThreads ? { allThreads: true } : {}) });
      } catch (error) {
        throw new Error(
          `The cancelled ${approvalMode === "full" ? "Full access" : "Custom approval"} grant could not be revoked: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    throw new DOMException("The bot update was cancelled", "AbortError");
  };

  if (leavesCustom) {
    const modeBot = await trustedApprovals.setMode(botId, approvalMode, trustedOptions);
    await rejectCancelledTrustedGrant();
    if (Object.keys(ordinaryPatch).length === 0) return modeBot;
    const result = await request(`/api/bots/${botId}`, {
      method: "PATCH",
      body: JSON.stringify(ordinaryPatch),
      signal,
    });
    return result.bot;
  }

  if (Object.keys(ordinaryPatch).length > 0) {
    await request(`/api/bots/${botId}`, {
      method: "PATCH",
      body: JSON.stringify(ordinaryPatch),
      signal,
    });
  }
  if (signal.aborted) throw new DOMException("The bot update was cancelled", "AbortError");
  const modeBot = await trustedApprovals.setMode(botId, approvalMode, trustedOptions);
  await rejectCancelledTrustedGrant();
  return modeBot;
}

const pendingBotDeletions = new Map<string, Promise<void>>();

export async function requestConfirmedBotDeletion(
  botId: string,
  requestDelete: (botId: string) => Promise<unknown>,
  onConfirmed: (botId: string) => void,
): Promise<void> {
  const existing = pendingBotDeletions.get(botId);
  if (existing) return existing;
  const deletion = (async () => {
    await requestDelete(botId);
    onConfirmed(botId);
  })();
  pendingBotDeletions.set(botId, deletion);
  try {
    await deletion;
  } finally {
    if (pendingBotDeletions.get(botId) === deletion) pendingBotDeletions.delete(botId);
  }
}

export interface PeripheralSnapshotLoad<Key extends string = string> {
  key: Key;
  load: () => Promise<void>;
}

function normalizeSnapshotFailure(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export async function loadSnapshotBoundary<Key extends string>(
  loadChat: () => Promise<void>,
  peripherals: readonly PeripheralSnapshotLoad<Key>[],
  onPeripheralFailure: (part: PeripheralSnapshotLoad<Key>, error: Error) => void,
): Promise<boolean> {
  const [chat, ...settledPeripherals] = await Promise.allSettled([
    loadChat(),
    ...peripherals.map((part) => part.load()),
  ]);
  settledPeripherals.forEach((result, index) => {
    if (result.status === "rejected") {
      onPeripheralFailure(peripherals[index]!, normalizeSnapshotFailure(result.reason));
    }
  });
  return chat.status === "fulfilled";
}

export function runtimeFrameAction(event: RuntimeEvent): Action | null {
  return event.type === "turn.started" || event.type === "session.model-variants" || event.type === "turn.completed"
    ? { type: "modelVariantRuntime", event }
    : null;
}

const StoreContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
  flushBotPatches: (botId: string) => Promise<BotAnnouncement | null>;
  refreshInstances: () => Promise<void>;
  refreshModels: (instanceId: string) => Promise<void>;
} | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const taskWrites = useRef(new Map<string, { botId: string; updatesDefault: boolean; promise: Promise<BotAnnouncement>; execution: Promise<unknown>; patch: TaskUpdatePatch }>()).current;
  const withTaskWrites = (bot: BotAnnouncement): BotAnnouncement => ({
    ...bot,
    tasks: bot.tasks?.map((task) => ({ ...task, ...taskPatchFields(taskWrites.get(task.threadId)?.patch ?? {}) })),
  });
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const botPatchQueue = useMemo(
    () =>
      createBotPatchQueue({
        send: (botId, patch, signal, currentBot) =>
          persistBotUpdate(botId, patch, signal, api, window.laterdog?.approvals, currentBot),
        reconcile: async (botId, signal) => {
          const result: { bots: BotAnnouncement[] } = await api(`/api/bots?messages=${MESSAGE_PAGE_SIZE}`, { signal });
          return result.bots.find((candidate) => candidate.id === botId) ?? null;
        },
        onAuthoritative: (bot, optimisticOverlay) => {
          rawDispatch({ type: "botPatched", bot: withTaskWrites({ ...bot, ...optimisticOverlay }) });
        },
        onError: (error) => {
          rawDispatch({ type: "error", message: error.message });
          setTimeout(() => rawDispatch({ type: "error", message: null }), 6000);
        },
      }),
    [],
  );

  useEffect(() => {
    botPatchQueue.revive();
    return () => botPatchQueue.dispose();
  }, [botPatchQueue]);

  const dispatch = useMemo(() => {
    const navigation = new Map<string, number>();
    const olderPagesInFlight = new Set<string>();
    let creatingBot = false;
    const showError = (e: unknown) => {
      rawDispatch({ type: "error", message: plainClientError(e) });
      setTimeout(() => rawDispatch({ type: "error", message: null }), 6000);
    };
    const cardTarget = (action: { botId: string; messageId: string; groupId?: string }) => {
      const host = action.groupId
        ? stateRef.current.groups.find((g) => g.id === action.groupId)
        : stateRef.current.bots.find((b) => b.id === action.botId);
      return { host, card: host?.messages.find((m) => m.id === action.messageId)?.card, inRoom: !!action.groupId };
    };
    const persistCard = (botId: string, messageId: string, patch: Partial<OptionCardData>) => {
      fetch(`/api/bots/${botId}/cards/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {});
    };

    const waitForExecutionSettings = async (expectedBots: Bot[], threadId?: string) => {
      const taskWrite = threadId ? taskWrites.get(threadId)?.execution : undefined;
      const defaultWrites = [...taskWrites.values()].filter((write) => write.updatesDefault && expectedBots.some((bot) => bot.id === write.botId));
      await Promise.all([taskWrite, ...defaultWrites.map((write) => write.execution), ...expectedBots.map(async (expected) => {
        const persisted = await botPatchQueue.flush(expected.id);
        if (!persisted) return;
        const expectedSelection = expected.modelSelection;
        if (
          approvalModeFor(persisted) !== approvalModeFor(expected) ||
          (persisted.memoryEnabled !== false) !== (expected.memoryEnabled !== false) ||
          persisted.modelSelection.instanceId !== expectedSelection.instanceId ||
          persisted.modelSelection.model !== expectedSelection.model ||
          persisted.modelSelection.effort !== expectedSelection.effort ||
          persisted.modelSelection.variant !== expectedSelection.variant
        ) {
          throw new Error("The approval level, memory setting, or model could not be saved, so this work was not started");
        }
      })]);
      if (threadId) await taskWrites.get(threadId)?.execution;
    };

    const persistTaskPatch = (botId: string, threadId: string, patch: TaskUpdatePatch) => {
      const previous = taskWrites.get(threadId);
      const defaults = patch.updateBotDefault || patch.approvalMode !== undefined
        ? [...taskWrites.values()].filter((write) => write.botId === botId) : [];
      const promise = Promise.all([previous?.promise, ...defaults.map((write) => write.promise)].map((save) => save?.catch(() => {})))
        .then(async () => {
          if (patch.resetApprovalToAsk && window.laterdog?.approvals) {
            return window.laterdog.approvals.setMode(botId, "ask", {
              threadId, modelSelection: patch.modelSelection, updateBotDefault: Boolean(patch.updateBotDefault),
            });
          }
          return persistTaskApproval(botId, threadId, patch, window.laterdog?.approvals);
        });
      const execution = Promise.all([previous?.execution, promise]);
      void execution.catch(() => {});
      const pending = { botId, updatesDefault: Boolean(patch.updateBotDefault || previous?.updatesDefault), patch: { ...previous?.patch, ...patch }, promise, execution };
      taskWrites.set(threadId, pending);
      void pending.promise.then((bot) => {
        if (taskWrites.get(threadId) !== pending) return;
        taskWrites.delete(threadId);
        if (bot) rawDispatch({ type: "botPatched", bot: withTaskWrites(bot) });
      }).catch((error) => {
        showError(error);
        if (taskWrites.get(threadId) === pending) {
          pending.patch = {};
          void api(`/api/bots?messages=${MESSAGE_PAGE_SIZE}`).then(({ bots }) => {
            if (taskWrites.get(threadId) !== pending) return;
            const bot = bots.find((candidate: Bot) => candidate.id === botId);
            if (bot) {
              rawDispatch({ type: "botPatched", bot: withTaskWrites(bot) });
              taskWrites.delete(threadId);
            }
          }).catch(() => {});
        }
      });
    };

    const executionBotsForThread = (threadId: string): Bot[] => {
      const snapshot = stateRef.current;
      const botIds = new Set<string>();
      for (const bot of snapshot.bots) {
        if (bot.threadId === threadId || bot.tasks?.some((task) => task.threadId === threadId)) {
          botIds.add(bot.id);
        }
      }
      for (const group of snapshot.groups) {
        if (group.threadId === threadId || group.tasks?.some((task) => task.threadId === threadId)) {
          for (const memberId of group.memberIds) botIds.add(memberId);
        }
      }
      return snapshot.bots.filter((bot) => botIds.has(bot.id));
    };

    const wrapped: React.Dispatch<Action> = (action) => {
      action = pinBotThreadAction(action, stateRef.current.bots);
      if (action.type === "taskSwitched") action = { ...action, bot: withTaskWrites(action.bot) as Bot };
      if (action.type === "botPatched") action = { ...action, bot: withTaskWrites(action.bot) };
      if ((action.type === "send" || action.type === "sendGroup" || action.type === "editMessage") && !action.sendId) {
        const { bots, groups } = stateRef.current;
        let heldSendId: string | undefined;
        if (action.type === "send") {
          const { botId, threadId, text, replyToId } = action;
          heldSendId = uncertainSends.recall(botId, threadId ?? bots.find((bot) => bot.id === botId)?.threadId, text, replyToId);
        } else if (action.type === "sendGroup") {
          const { groupId, threadId, text, replyToId, mode } = action;
          heldSendId = uncertainSends.recall(groupId, threadId ?? groups.find((group) => group.id === groupId)?.threadId, text, `${replyToId ?? ""}|${mode ?? "chat"}`);
        }
        action = { ...action, sendId: heldSendId ?? crypto.randomUUID() };
      }
      const botBeforeUpdate =
        action.type === "updateBot" || action.type === "setModel"
          ? stateRef.current.bots.find((candidate) => candidate.id === action.botId)
          : undefined;
      const botBeforeSend =
        action.type === "send"
          ? stateRef.current.bots.find((candidate) => candidate.id === action.botId)
          : undefined;
      const leafBeforeEdit =
        action.type === "editMessage"
          ? stateRef.current.bots.find((candidate) => candidate.id === action.botId)?.activeLeafId ?? null
          : null;
      const executionBotsBeforeAction = (() => {
        if (action.type === "editMessage" || action.type === "answerCard") {
          const bot = stateRef.current.bots.find((candidate) => candidate.id === action.botId);
          return bot ? [bot] : [];
        }
        if (action.type === "decideRequest") {
          const bots = executionBotsForThread(action.threadId);
          if (!action.alwaysAllow || bots.some((bot) => bot.id === action.alwaysAllow?.botId)) {
            return bots;
          }
          const grantBot = stateRef.current.bots.find((bot) => bot.id === action.alwaysAllow?.botId);
          return grantBot ? [...bots, grantBot] : bots;
        }
        if (action.type === "sendGroup") {
          const memberIds = stateRef.current.groups.find((group) => group.id === action.groupId)?.memberIds ?? [];
          return stateRef.current.bots.filter((candidate) => memberIds.includes(candidate.id));
        }
        if (action.type === "runRoutine") {
          const routine = stateRef.current.routines.find((candidate) => candidate.id === action.routineId);
          if (!routine) return [];
          const ids = new Set([routine.botId]);
          if (routine.target === "room-goal" && routine.groupId) {
            const group = stateRef.current.groups.find((candidate) => candidate.id === routine.groupId);
            for (const memberId of group?.memberIds ?? []) ids.add(memberId);
          }
          return stateRef.current.bots.filter((candidate) => ids.has(candidate.id));
        }
        return [];
      })();
      const quizBeforeSend = (() => {
        if (action.type !== "send") return undefined;
        return botBeforeSend ? openOnboardingCard(botBeforeSend) : undefined;
      })();
      if (
        action.type !== "cancelQueued" &&
        action.type !== "cancelGroupQueued" &&
        action.type !== "deleteBot"
      ) rawDispatch(action);
      switch (action.type) {
        case "loadOlderMessages": {
          if (olderPagesInFlight.has(action.threadId)) break;
          olderPagesInFlight.add(action.threadId);
          const current = stateRef.current;
          const owner = [...current.bots, ...current.groups].find((candidate) => candidate.threadId === action.threadId);
          const before = owner?.messages[0]?.id;
          const generation = current.transcriptGeneration[action.threadId] ?? 0;
          if (!before) {
            olderPagesInFlight.delete(action.threadId);
            rawDispatch({ type: "olderMessages", threadId: action.threadId, generation, messages: [], hasMore: false });
            break;
          }
          api<{ messages: Message[]; hasMore?: boolean }>(
            `/api/threads/${action.threadId}/messages?limit=${MESSAGE_PAGE_SIZE}&before=${encodeURIComponent(before)}`,
          )
            .finally(() => olderPagesInFlight.delete(action.threadId))
            .then((page) => rawDispatch({
              type: "olderMessages",
              threadId: action.threadId,
              generation,
              messages: page.messages ?? [],
              hasMore: Boolean(page.hasMore),
            }))
            .catch((error) => {
              rawDispatch({ type: "olderMessages", threadId: action.threadId, generation, messages: [], hasMore: true });
              showError(error);
            });
          break;
        }
        case "notice":
          if (action.notice) setTimeout(() => rawDispatch({ type: "notice", notice: null }), 6000);
          break;
        case "createRoutine":
          api("/api/routines", { method: "POST", body: JSON.stringify(action.input) }).catch(showError);
          break;
        case "updateRoutine":
          api(`/api/routines/${action.routineId}`, {
            method: "PATCH",
            body: JSON.stringify(action.patch),
          }).catch(showError);
          break;
        case "deleteRoutine":
          api(`/api/routines/${action.routineId}`, { method: "DELETE" }).catch(showError);
          break;
        case "runRoutine":
          void waitForExecutionSettings(executionBotsBeforeAction)
            .then(() => api(`/api/routines/${action.routineId}/run`, { method: "POST" }))
            .then(({ run }) => action.onStarted?.(run))
            .catch((error) => {
              if (action.onError) action.onError(error);
              else showError(error);
            })
            .finally(() => action.onSettled?.());
          break;
        case "cancelRoutineRun":
          api(`/api/routine-runs/${action.runId}/cancel`, { method: "POST" }).catch(showError);
          break;
        case "cancelQueued":
          void api(`/api/bots/${action.botId}/queue/${action.queueId}`, { method: "DELETE", body: JSON.stringify({ threadId: action.threadId }) })
            .then(() => {
              rawDispatch(action);
              action.onCancelled?.();
            })
            .catch(showError);
          break;
        case "steerQueued":
          void api(`/api/bots/${action.botId}/queue/${action.queueId}/steer`, { method: "POST", body: JSON.stringify({ threadId: action.threadId }) })
            .then((body) => {
              if (body?.steered === true && Array.isArray(body.messages) && typeof body.threadId === "string") {
                for (const message of body.messages) {
                  rawDispatch({ type: "messageAdded", threadId: body.threadId, message });
                }
                for (const queueId of body.queueIds ?? []) {
                  rawDispatch({ type: "consumePendingQueued", threadId: body.threadId, queueId });
                }
              }
              action.onSettled?.();
            })
            .catch((error) => {
              showError(error);
              action.onError?.();
            });
          break;
        case "cancelGroupQueued":
          void api(`/api/groups/${action.groupId}/queue/${action.queueId}`, { method: "DELETE" })
            .then(() => {
              rawDispatch(action);
              action.onCancelled?.();
            })
            .catch(showError);
          break;
        case "steerGroupQueued":
          void api(`/api/groups/${action.groupId}/queue/${action.queueId}/steer`, {
            method: "POST",
            body: JSON.stringify({ threadId: action.threadId }),
          })
            .then((body) => {
              if (body?.steered === true && Array.isArray(body.messages) && typeof body.threadId === "string") {
                for (const message of body.messages) {
                  rawDispatch({ type: "messageAdded", threadId: body.threadId, message });
                }
                for (const queueId of body.queueIds ?? []) {
                  rawDispatch({ type: "consumePendingQueued", threadId: body.threadId, queueId });
                }
              }
              action.onSettled?.();
            })
            .catch((error) => {
              showError(error);
              action.onError?.();
            });
          break;
        case "send": {
          if (quizBeforeSend) persistCard(action.botId, quizBeforeSend.id, { dismissed: true });
          const threadId =
            action.threadId ?? stateRef.current.bots.find((bot) => bot.id === action.botId)?.threadId;
          const sendId = action.sendId ?? crypto.randomUUID();
          void waitForExecutionSettings(botBeforeSend ? [botBeforeSend] : [], threadId)
            .then(() => sendWithRetry(() => api(`/api/bots/${action.botId}/messages`, {
                method: "POST",
                body: JSON.stringify({ text: action.text, replyToId: action.replyToId, threadId, sendId, deliver: action.deliver }),
                timeoutMs: SEND_ATTEMPT_TIMEOUT_MS,
              })))
            .then((body) => {
              uncertainSends.forget(action.botId, threadId, action.text, action.replyToId);
              if (body?.message && typeof body.threadId === "string") {
                rawDispatch({ type: "messageAdded", threadId: body.threadId, message: body.message });
              }
              if (
                body?.queued &&
                typeof body.threadId === "string" &&
                typeof body.queueId === "string"
              ) {
                rawDispatch({
                  type: "optimisticMessageRemoved",
                  threadId: body.threadId,
                  sendId,
                });
                rawDispatch({
                  type: "pendingQueued",
                  threadId: body.threadId,
                  queueId: body.queueId,
                  text: action.text,
                  reason: body.reason === "capacity" || body.reason === "group-turn" ? body.reason : undefined,
                });
              }
            })
            .catch((error) => {
              if (isUncertainSendFailure(error)) uncertainSends.remember(action.botId, threadId, action.text, sendId, action.replyToId);
              if (threadId) {
                rawDispatch({ type: "optimisticMessageRemoved", threadId, sendId });
              }
              showError(error);
              action.onError?.();
            });
          break;
        }
        case "editMessage": {
          const threadId =
            action.threadId ?? stateRef.current.bots.find((bot) => bot.id === action.botId)?.threadId;
          const sendId = action.sendId ?? crypto.randomUUID();
          void waitForExecutionSettings(executionBotsBeforeAction, threadId)
            .then(() => api(`/api/bots/${action.botId}/messages/${action.messageId}/edit`, {
              method: "POST",
              body: JSON.stringify({ text: action.text.trim(), threadId, sendId }),
            }))
            .then((body) => {
              if (body?.message && threadId) {
                rawDispatch({ type: "messageAdded", threadId, message: body.message });
              }
            })
            .catch((error) => {
              if (threadId) {
                rawDispatch({ type: "optimisticMessageRemoved", threadId, sendId, restoreLeafId: leafBeforeEdit });
              }
              showError(error);
            });
          break;
        }
        case "switchBranch":
          api(`/api/bots/${action.botId}/active-branch`, {
            method: "POST",
            body: JSON.stringify({ messageId: action.messageId, threadId: action.threadId }),
          }).catch(showError);
          break;
        case "decideRequest": {
          const respond = (scope: typeof action.scope) =>
            api(`/api/threads/${action.threadId}/respond`, {
              method: "POST",
              body: JSON.stringify({
                requestId: action.requestId,
                behavior: action.behavior,
                message: action.message,
                reviewedSha256: action.reviewedSha256,
                always: action.always,
                rememberCommand: action.rememberCommand,
                scope,
              }),
            });
          void waitForExecutionSettings(executionBotsBeforeAction, action.threadId)
            .then(async () => {
              let grantSaved = true;
              if (action.alwaysAllow) {
                const bot = stateRef.current.bots.find((candidate) => candidate.id === action.alwaysAllow?.botId);
                const owner = action.alwaysAllow.key === MAC_ALLOW_KEY || bot?.tasks?.some((task) => task.threadId === action.threadId);
                const next = [...new Set([...(bot ? currentTaskBot(bot, action.threadId).alwaysAllow ?? [] : []), action.alwaysAllow.key])];
                try {
                  await api(owner ? `/api/bots/${action.alwaysAllow.botId}/always-allow` : `/api/bots/${action.alwaysAllow.botId}`, {
                    method: owner ? "POST" : "PATCH",
                    body: JSON.stringify(owner ? { threadId: action.threadId, allowKey: action.alwaysAllow.key } : { alwaysAllow: next }),
                  });
                } catch (error) {
                  grantSaved = false;
                  showError(error);
                }
              }
              const response = await respond(grantSaved || action.scope !== "always" ? action.scope : "once");
              if (response?.settlementPending && typeof response.message === "string") {
                showError(new Error(response.message));
              }
            })
            .catch((error) => {
              showError(error);
              action.onError?.(error instanceof Error ? error.message : String(error));
            });
          break;
        }
        case "answerCard": {
          const { host, card, inRoom } = cardTarget(action);
          void waitForExecutionSettings(executionBotsBeforeAction, action.threadId)
            .then(() => {
              if (card?.requestId && host) {
                const response = card.skillRequest
                  ? { behavior: skillRequestBehavior(action.answer) }
                  : answerResponse(card, action.answer);
                return api(`/api/threads/${action.threadId ?? host.threadId}/respond`, {
                  method: "POST",
                  body: JSON.stringify({
                    requestId: card.requestId,
                    ...response,
                    reviewedSha256: response.behavior === "allow" && card.skillRequest
                      ? reviewedSkillSha256(card.skillRequest)
                      : undefined,
                  }),
                });
              }
              if (inRoom) return;
              persistCard(action.botId, action.messageId, { answered: action.answer, dismissed: true });
              return api(`/api/bots/${action.botId}/messages`, {
                method: "POST",
                body: JSON.stringify({ text: action.answer, threadId: action.threadId }),
              });
            })
            .catch(showError);
          break;
        }
        case "dismissCard": {
          const { host, card, inRoom } = cardTarget(action);
          if (card?.requestId && host) {
            api(`/api/threads/${action.threadId ?? host.threadId}/respond`, {
              method: "POST",
              body: JSON.stringify({ requestId: card.requestId, ...dismissResponse(card) }),
            }).catch(() => {});
          } else if (!inRoom) {
            persistCard(action.botId, action.messageId, { dismissed: true });
          }
          break;
        }
        case "newBot": {
          if (creatingBot) break;
          creatingBot = true;
          rawDispatch({ type: "botCreationPending", on: true });
          void createDog({ name: action.name, title: action.title, avatarUrl: action.avatarUrl, avatarCrop: action.avatarCrop, modelSelection: action.modelSelection, visibility: action.visibility, section: action.section, offLeash: action.offLeash })
            .then(({ bot }) => {
              rawDispatch({ type: "botAdded", bot, preserveSelection: action.preserveSelection });
              action.onCreated?.(bot);
              void api(`/api/bots/${bot.id}/hello`, { method: "POST" }).catch(() => {});
            })
            .catch((error) => {
              if (action.onError) action.onError(error instanceof Error ? error.message : String(error));
              else showError(error);
            })
            .finally(() => {
              creatingBot = false;
              rawDispatch({ type: "botCreationPending", on: false });
            });
          break;
        }
        case "duplicateBot": {
          const source = stateRef.current.bots.find((b) => b.id === action.botId);
          if (!source) break;
          const duplicateProfile = duplicateProfileFor(source);
          api("/api/bots", {
            method: "POST",
            body: JSON.stringify({
              ...(source.visibility && source.visibility !== "everyone" ? { visibility: source.visibility } : {}),
              ...(Object.hasOwn(source, "toolScope") ? { settings: { toolScope: source.toolScope } } : {}),
            }),
          })
            .then(({ bot }) =>
              api(`/api/bots/${bot.id}`, {
                method: "PATCH",
                body: JSON.stringify(duplicateProfile),
              }).then(({ bot: patched }) =>
                rawDispatch({ type: "botAdded", bot: { ...bot, ...patched, messages: bot.messages } }),
              ),
            )
            .catch(showError);
          break;
        }
        case "deleteBot":
          rawDispatch({ type: "botDeletionPending", botId: action.botId, on: true });
          void requestConfirmedBotDeletion(
            action.botId,
            async (botId) => {
              await botPatchQueue.flush(botId);
              return api(`/api/bots/${botId}`, { method: "DELETE" });
            },
            (botId) => {
              botPatchQueue.cancel(botId);
              rawDispatch({ type: "deleteBot", botId });
            },
          )
            .catch(showError)
            .finally(() => rawDispatch({ type: "botDeletionPending", botId: action.botId, on: false }));
          break;
        case "markUnread":
          api(`/api/bots/${action.botId}`, { method: "PATCH", body: JSON.stringify({ unread: true }) }).catch(
            () => {},
          );
          break;
        case "select": {
          const bot = stateRef.current.bots.find((b) => b.id === action.id);
          const group = stateRef.current.groups.find((g) => g.id === action.id);
          if (bot?.unread) {
            api(`/api/bots/${action.id}/read`, { method: "POST", body: JSON.stringify({ threadId: bot.threadId }) }).catch(() => {});
          } else if (group?.unread) {
            api(`/api/groups/${action.id}/read`, { method: "POST" }).catch(() => {});
          }
          break;
        }
        case "createGroup":
          api(`/api/groups`, {
            method: "POST",
            body: JSON.stringify({
              memberIds: action.memberIds,
              name: action.name,
              section: action.section,
              setup: {
                bulletin: "",
                defaultResponder: window.laterdog?.remoteClient?.active
                  ? { kind: "mentions" }
                  : jevRoomRoutingOn(stateRef.current.config)
                    ? { kind: "auto", fallbackBotId: action.memberIds[0] }
                    : { kind: "member", botId: action.memberIds[0] },
              },
            }),
          })
            .then(({ group }) => {
              rawDispatch({ type: "groupPatched", group });
              rawDispatch({ type: "select", id: group.id });
            })
            .catch(showError);
          break;
        case "sendGroup": {
          const threadId =
            action.threadId ?? stateRef.current.groups.find((group) => group.id === action.groupId)?.threadId;
          const sendId = action.sendId ?? crypto.randomUUID();
          void waitForExecutionSettings(executionBotsBeforeAction)
            .then(() => sendWithRetry(() => api(`/api/groups/${action.groupId}/messages`, {
              method: "POST",
              body: JSON.stringify({
                text: action.text,
                replyToId: action.replyToId,
                threadId,
                sendId,
                mode: action.mode ?? "chat",
              }),
              timeoutMs: SEND_ATTEMPT_TIMEOUT_MS,
            })))
            .then((body) => {
              uncertainSends.forget(action.groupId, threadId, action.text, `${action.replyToId ?? ""}|${action.mode ?? "chat"}`);
              if (body?.message && typeof body.threadId === "string") {
                rawDispatch({ type: "messageAdded", threadId: body.threadId, message: body.message });
              }
              if (
                body?.queued &&
                typeof body.threadId === "string" &&
                typeof body.queueId === "string"
              ) {
                rawDispatch({
                  type: "optimisticMessageRemoved",
                  threadId: body.threadId,
                  sendId,
                });
                rawDispatch({
                  type: "pendingQueued",
                  threadId: body.threadId,
                  queueId: body.queueId,
                  text: action.text,
                });
              }
            })
            .catch((error) => {
              if (isUncertainSendFailure(error)) uncertainSends.remember(action.groupId, threadId, action.text, sendId, `${action.replyToId ?? ""}|${action.mode ?? "chat"}`);
              if (threadId) {
                rawDispatch({ type: "optimisticMessageRemoved", threadId, sendId });
              }
              showError(error);
              action.onError?.();
            });
          break;
        }
        case "patchGroup":
          api(`/api/groups/${action.groupId}`, {
            method: "PATCH",
            body: JSON.stringify(action.patch),
          }).catch(showError);
          break;
        case "deleteGroup":
          api(`/api/groups/${action.groupId}`, { method: "DELETE" }).catch(showError);
          break;
        case "setModel":
          if (action.threadId) {
            persistTaskPatch(action.botId, action.threadId, {
              modelSelection: action.selection,
              ...(action.updateBotDefault ? { updateBotDefault: true } : {}),
              ...(action.resetApprovalToAsk ? { resetApprovalToAsk: true } : {}),
            });
            break;
          }
          if (botBeforeUpdate) {
            botPatchQueue.enqueue(
              action.botId,
              { modelSelection: action.selection },
              botBeforeUpdate,
            );
          }
          break;
        case "updateTask":
          persistTaskPatch(action.botId, action.threadId, action.patch);
          break;
        case "refreshTaskPermissions": {
          const bot = stateRef.current.bots.find((candidate) => candidate.id === action.botId);
          const task = bot?.tasks?.find((candidate) => candidate.threadId === action.threadId);
          if (!bot || !task) {
            showError(new Error("That thread is no longer available"));
            break;
          }
          const mode = approvalModeFor(bot);
          const current = approvalModeFor(currentTaskBot(bot, action.threadId));
          const acknowledgeLocalAuto = action.acknowledgeLocalAuto === true;
          const needsDesktop = mode === "full" || mode === "custom" || current === "custom";
          const refreshed = needsDesktop
            ? window.laterdog?.approvals
              ? window.laterdog.approvals.setMode(action.botId, mode, {
                threadId: action.threadId, threadOnly: true, refreshPermissions: true, acknowledgeLocalAuto,
              })
              : Promise.reject(new Error("This approval change requires the packaged desktop app"))
            : api<{ bot: BotAnnouncement }>(`/api/bots/${action.botId}/tasks/${action.threadId}`, {
              method: "PATCH",
              body: JSON.stringify({ refreshPermissions: true, ...(acknowledgeLocalAuto ? { acknowledgeLocalAuto: true } : {}) }),
            }).then((result) => result.bot);
          void refreshed.then((updated) => {
            if (updated) rawDispatch({ type: "botPatched", bot: withTaskWrites(updated) });
          }).catch(showError);
          break;
        }
        case "followBotModel":
          void api<{ bot: BotAnnouncement }>(`/api/bots/${action.botId}/threads/follow-model`, { method: "POST", body: "{}" })
            .then(({ bot }) => rawDispatch({ type: "botPatched", bot: withTaskWrites(bot) }))
            .catch(showError);
          break;
        case "createProject":
          api(`/api/bots/${action.botId}/projects`, { method: "POST", body: JSON.stringify({ name: action.name, emoji: action.emoji }) })
            .then(({ bot, project }) => {
              dispatch({ type: "botPatched", bot });
              action.onCreated?.(project);
            }).catch((error) => { showError(error); action.onError?.(error instanceof Error ? error.message : String(error)); });
          break;
        case "updateProject":
          api(`/api/bots/${action.botId}/projects/${action.projectId}`, { method: "PATCH", body: JSON.stringify(action.patch) })
            .then(({ bot }) => { dispatch({ type: "botPatched", bot }); action.onSaved?.(); })
            .catch((error) => { showError(error); action.onError?.(error instanceof Error ? error.message : String(error)); });
          break;
        case "deleteProject":
          api(`/api/bots/${action.botId}/projects/${action.projectId}`, { method: "DELETE" })
            .then(({ bot }) => { dispatch({ type: "botPatched", bot }); action.onDeleted?.(); })
            .catch((error) => { showError(error); action.onError?.(error instanceof Error ? error.message : String(error)); });
          break;
        case "reorderProjects":
          api(`/api/bots/${action.botId}/projects/order`, { method: "PATCH", body: JSON.stringify({ projectIds: action.projectIds }) })
            .then(({ bot }) => { dispatch({ type: "botPatched", bot }); action.onSaved?.(); })
            .catch((error) => { showError(error); action.onError?.(error instanceof Error ? error.message : String(error)); });
          break;
        case "interrupt":
          api(`/api/bots/${action.botId}/interrupt`, {
            method: "POST",
            body: action.threadId ? JSON.stringify({ threadId: action.threadId }) : undefined,
          }).catch((error) => {
            showError(error);
            action.onError?.();
          });
          break;
        case "newTask":
        case "switchTask": {
          const revision = (navigation.get(action.botId) ?? 0) + 1;
          navigation.set(action.botId, revision);
          const ready = action.type === "newTask"
            ? botPatchQueue.flush(action.botId)
            : Promise.resolve();
          void ready.then(() => api<{ bot: Bot }>(action.type === "newTask"
            ? `/api/bots/${action.botId}/tasks`
            : `/api/bots/${action.botId}/tasks/${action.threadId}?messages=${MESSAGE_PAGE_SIZE}`, { method: "POST", body: JSON.stringify(action.type === "newTask" ? { projectId: action.projectId } : {}) }))
            .then((r) => {
              if (!r?.bot || navigation.get(action.botId) !== revision) return;
              dispatch({ type: "taskSwitched", bot: r.bot });
            })
            .catch(showError);
          break;
        }
        case "renameTask":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: action.title }),
          }).catch(showError);
          break;
        case "regenerateTaskTitle":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}/title`, { method: "POST" })
            .then(() => action.onSettled?.(true))
            .catch((error) => { showError(error); action.onSettled?.(false); });
          break;
        case "deleteTask":
          api<{ bot?: BotAnnouncement }>(`/api/bots/${action.botId}/tasks/${action.threadId}`, { method: "DELETE" })
            .then((r) => r?.bot && dispatch({ type: "botPatched", bot: r.bot }))
            .catch(showError);
          break;
        case "newGroupTask":
          api<{ group?: Partial<Group> & { id: string } }>(`/api/groups/${action.groupId}/tasks`, { method: "POST", body: "{}" })
            .then((r) => r?.group && dispatch({ type: "groupPatched", group: r.group }))
            .catch(showError);
          break;
        case "switchGroupTask":
          api<{ group?: Partial<Group> & { id: string } }>(`/api/groups/${action.groupId}/tasks/${action.threadId}?messages=${MESSAGE_PAGE_SIZE}`, { method: "POST" })
            .then((r) => r?.group && dispatch({ type: "groupPatched", group: r.group }))
            .catch(showError);
          break;
        case "renameGroupTask":
          api(`/api/groups/${action.groupId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: action.title }),
          }).catch(showError);
          break;
        case "pinGroupTask":
          api(`/api/groups/${action.groupId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ pinned: action.pinned, title: action.title }),
          }).catch(showError);
          break;
        case "setConversationTurnLimit":
          api(action.dm ? `/api/groups/${action.groupId}` : `/api/groups/${action.groupId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ turnTimeoutMinutes: action.minutes }),
          }).catch(showError);
          break;
        case "deleteGroupTask":
          api<{ group?: Partial<Group> & { id: string } }>(`/api/groups/${action.groupId}/tasks/${action.threadId}`, { method: "DELETE" })
            .then((r) => r?.group && dispatch({ type: "groupPatched", group: r.group }))
            .catch(showError);
          break;
        case "interruptGroup":
          api(`/api/groups/${action.groupId}/interrupt`, {
            method: "POST",
            body: action.threadId ? JSON.stringify({ threadId: action.threadId }) : undefined,
          }).catch((error) => {
            showError(error);
            action.onError?.();
          });
          break;
        case "updateBot": {
          if (botBeforeUpdate) {
            botPatchQueue.enqueue(action.botId, action.patch, botBeforeUpdate);
          }
          break;
        }
        default:
          break;
      }
    };
    return wrapped;
  }, [botPatchQueue]);

  useEffect(() => {
    let alive = true;
    type PeripheralKey = "instances" | "config" | "routines" | "webhooks" | "helpers";
    type PeripheralPart = {
      key: PeripheralKey;
      request: () => Promise<() => void>;
    };
    type PeripheralRefresh = {
      attempt: number;
      generation: number;
      timer: ReturnType<typeof setTimeout> | null;
      version: number;
    };
    const peripheralRefresh = new Map<PeripheralKey, PeripheralRefresh>();
    const refreshState = (key: PeripheralKey) => {
      let current = peripheralRefresh.get(key);
      if (!current) {
        current = { attempt: 0, generation: 0, timer: null, version: 0 };
        peripheralRefresh.set(key, current);
      }
      return current;
    };
    const peripheralParts: PeripheralPart[] = [
      {
        key: "instances",
        request: async () => {
          const { instances } = await api("/api/instances");
          return () => rawDispatch({ type: "instances", instances });
        },
      },
      {
        key: "config",
        request: async () => {
          const config = await api("/api/config");
          return () => rawDispatch({ type: "configStatus", config });
        },
      },
      {
        key: "routines",
        request: async () => {
          const { routines, runs } = await api("/api/routines");
          return () => rawDispatch({ type: "routinesHydrated", routines, runs });
        },
      },
      {
        key: "helpers",
        request: async () => {
          const snapshot = await api<unknown>("/api/helpers").catch((error: unknown) => {
            if (error instanceof ApiError && error.status === 404) return null;
            throw error;
          });
          return () => receiveHelpersSnapshot(snapshot);
        },
      },
      ...(window.laterdog?.remoteClient?.active ? [] : [{
        key: "webhooks",
        request: async () => {
          const { webhooks, attempts, ingress } = await api("/api/webhooks");
          return () =>
            rawDispatch({ type: "webhooksHydrated", webhooks, attempts: attempts ?? [], ingress });
        },
      } satisfies PeripheralPart]),
    ];
    const partByKey = new Map(peripheralParts.map((part) => [part.key, part]));
    const schedulePeripheralRetry = (part: PeripheralPart, error?: Error) => {
      if (!alive) return;
      const refresh = refreshState(part.key);
      if (refresh.timer) return;
      if (error !== undefined) {
        if (part.key === "routines") rawDispatch({ type: "routinesLoadFailed" });
        console.warn(`snapshot: ${part.key} refresh failed; retrying`, error);
      }
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(refresh.attempt, 5));
      refresh.attempt += 1;
      refresh.timer = setTimeout(() => {
        refresh.timer = null;
        void loadPeripheral(part, true).catch((nextError) => schedulePeripheralRetry(part, nextError));
      }, delay);
    };
    const loadPeripheral = async (part: PeripheralPart, protectLiveFrames: boolean): Promise<void> => {
      const refresh = refreshState(part.key);
      if (refresh.timer) {
        clearTimeout(refresh.timer);
        refresh.timer = null;
      }
      const generation = ++refresh.generation;
      const version = refresh.version;
      try {
        const apply = await part.request();
        if (!alive || refresh.generation !== generation) return;
        if (protectLiveFrames && refresh.version !== version) {
          schedulePeripheralRetry(part);
          return;
        }
        apply();
        refresh.attempt = 0;
      } catch (error) {
        if (!alive || refresh.generation !== generation) return;
        throw normalizeSnapshotFailure(error);
      }
    };
    const bumpPeripheralVersion = (...keys: PeripheralKey[]) => {
      for (const key of keys) refreshState(key).version += 1;
    };
    const loadAll = async (): Promise<boolean> => {
      const since = stateRef.current.liveCallVersion;
      const seq = nextLiveCallLookup();
      void api<unknown>("/api/live/call")
        .then((body) => {
          const answer = liveCallFromFrame(body);
          if (alive && answer) flushSync(() => rawDispatch({ type: "liveCallLookup", call: answer.call, since, seq }));
        })
        .catch(() => {});
      const chat = () =>
        api(`/api/bots?messages=${MESSAGE_PAGE_SIZE}`).then(({ bots, groups, sections, computerControl, botQueuedMessages }) => {
          if (!alive) return;
          rawDispatch({
            type: "hydrate",
            bots,
            groups: groups ?? [],
            sections: sections ?? [],
            computerControl: computerControl ?? {},
            botQueuedMessages,
          });
        });
      const peripherals = peripheralParts.map((part) => ({
        key: part.key,
        load: () => loadPeripheral(part, false),
      }));
      const chatReady = await loadSnapshotBoundary(chat, peripherals, (failed, error) => {
        const part = partByKey.get(failed.key);
        if (part) schedulePeripheralRetry(part, error);
      });
      return alive && chatReady;
    };

    let hydrated = false;
    let hydrationPromise: Promise<boolean> | null = null;
    let rehydrateRequested = false;
    const pendingFrames: ServerFrame[] = [];
    let handleFrame: (frame: ServerFrame) => void;
    const hydrate = (): Promise<boolean> => {
      if (hydrationPromise) {
        rehydrateRequested = true;
        return hydrationPromise;
      }
      hydrated = false;
      hydrationPromise = (async () => {
        let loaded = false;
        do {
          rehydrateRequested = false;
          loaded = await loadAll();
        } while (alive && rehydrateRequested);
        if (!alive || !loaded) return false;
        hydrated = true;
        for (const frame of pendingFrames.splice(0)) handleFrame(frame);
        return true;
      })().finally(() => {
        hydrationPromise = null;
      });
      return hydrationPromise;
    };
    const hydrationFallback = setTimeout(hydrate, 1_000);

    handleFrame = (frame) => {
      if (frame.kind === "config") bumpPeripheralVersion("config", "instances");
      else if (frame.kind === "routine" || frame.kind === "routine.deleted" || frame.kind === "routine.run") {
        bumpPeripheralVersion("routines");
      } else if (
        frame.kind === "webhook" ||
        frame.kind === "webhook.attempt" ||
        frame.kind === "webhook.deleted"
      ) {
        bumpPeripheralVersion("webhooks");
      }
      switch (frame.kind) {
        case "sections":
          rawDispatch({ type: "sections", sections: frame.sections });
          break;
        case "bot.queued":
          rawDispatch({ type: "botQueues", queues: frame.queues });
          break;
        case "message": {
          rawDispatch({ type: "messageAdded", threadId: frame.threadId, message: frame.message as Message });
          if (frame.message?.role === "user" && typeof frame.message.queueId === "string") {
            rawDispatch({
              type: "consumePendingQueued",
              threadId: frame.threadId,
              queueId: frame.message.queueId,
            });
          }
          if (frame.message?.role === "bot" && frame.message?.kind === "text") {
            const owner = stateRef.current.bots.find((b) => b.threadId === frame.threadId || b.tasks?.some((task) => task.threadId === frame.threadId));
            const live = stateRef.current.liveCall;
            const onLiveCall = Boolean(live && live.status !== "ended" && live.botId === owner?.id);
            if (owner?.speakReplies && currentCall() === null && !onLiveCall && frame.message.text?.trim()) {
              void speaker.speak(frame.message.text, {
                botId: owner.id,
                messageId: frame.message.id,
                voiceId: owner.voice,
              });
            }
          }
          break;
        }
        case "message.patch":
          rawDispatch({ type: "messagePatched", threadId: frame.threadId, message: frame.message as Message });
          break;
        case "thread":
          rawDispatch({ type: "threadActive", threadId: frame.threadId, activeLeafId: frame.activeLeafId });
          break;
        case "bot": {
          const bot = frame.bot as BotAnnouncement;
          const selected = stateRef.current.bots.find((candidate) => candidate.id === bot.id);
          const selectedTask = bot.tasks?.find((task) => task.threadId === selected?.threadId);
          if (bot.id === stateRef.current.selectedId && stateRef.current.activeView === "chat" && personIsLooking() &&
              (selectedTask?.unread || (!bot.tasks && bot.unread))) {
            if (selectedTask) selectedTask.unread = false;
            bot.unread = botShowsUnread(bot);
            fetch(`/api/bots/${bot.id}/read`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: selected?.threadId }) }).catch(() => {});
          }
          rawDispatch({
            type: "botPatched",
            bot: withTaskWrites({ ...bot, ...botPatchQueue.overlayFor(bot.id) }),
          });
          break;
        }
        case "group": {
          const group = frame.group as Partial<Group> & { id: string };
          if (group.unread && group.id === stateRef.current.selectedId && personIsLooking()) {
            group.unread = false;
            fetch(`/api/groups/${group.id}/read`, { method: "POST" }).catch(() => {});
          }
          rawDispatch({ type: "groupPatched", group });
          break;
        }
        case "notify":
          showNotification(
            frame.notification,
            (target) => openNotificationTarget(dispatch, target, stateRef.current),
            stateRef.current.bots.find((bot) => bot.id === frame.notification.botId)?.avatarUrl,
            visibleNotificationThread(stateRef.current),
          );
          break;
        case "group.deleted":
          rawDispatch({ type: "groupDeleted", groupId: frame.groupId });
          break;
        case "routine":
          rawDispatch({ type: "routinePatched", routine: frame.routine });
          break;
        case "routine.deleted":
          rawDispatch({ type: "routineDeleted", routineId: frame.routineId });
          break;
        case "routine.run":
          rawDispatch({ type: "routineRunPatched", run: frame.run });
          break;
        case "webhook":
          rawDispatch({ type: "webhookPatched", webhook: frame.webhook });
          break;
        case "webhook.attempt":
          rawDispatch({ type: "webhookAttempted", attempt: frame.attempt });
          break;
        case "webhook.deleted":
          rawDispatch({ type: "webhookDeleted", webhookId: frame.webhookId });
          break;
        case "runtime": {
          if (receiveHelperEvent(frame.event)) bumpPeripheralVersion("helpers");
          receiveReasoningEvent(frame.event);
          const action = runtimeFrameAction(frame.event);
          if (action) rawDispatch(action);
          break;
        }
        case "screen":
          if (stateRef.current.computerStarts[frame.botId]) {
            rawDispatch({ type: "computerStart", botId: frame.botId, start: null });
          }
          break;
        case "computer":
          rawDispatch({ type: "computerStart", botId: frame.botId,
            start: { state: frame.state, ...(frame.place ? { place: frame.place } : {}) } });
          break;
        case "computer-control":
          rawDispatch({
            type: "computerControl",
            botId: frame.botId,
            held: frame.held === true,
            helpReason: typeof frame.helpReason === "string" ? frame.helpReason : null,
          });
          break;
        case "bot.deleted":
          botPatchQueue.cancel(frame.botId);
          rawDispatch({ type: "deleteBot", botId: frame.botId });
          break;
        case "live.call": {
          const framed = liveCallFromFrame(frame);
          if (framed) flushSync(() => rawDispatch({ type: "liveCall", call: framed.call }));
          break;
        }
        case "config":
          rawDispatch({
            type: "configStatus",
            config: configStatusFromFrame(frame as unknown as ConfigStatusFrame),
          });
          {
            const instances = partByKey.get("instances");
            if (instances) {
              void loadPeripheral(instances, true).catch((error) =>
                schedulePeripheralRetry(instances, error),
              );
            }
          }
          break;
      }
    };
    const stopLive = openLiveEvents({
      onOpen: () => rawDispatch({ type: "connected", value: true }),
      onError: () => rawDispatch({ type: "connected", value: false }),
      onSnapshotRequired: () => {
        clearTimeout(hydrationFallback);
        publishMissedFrames();
        pendingFrames.splice(0);
        return hydrate();
      },
      onFrame: (frame) => {
        publishLiveFrame(frame as ServerFrame);
        if (hydrated) handleFrame(frame as ServerFrame);
        else pendingFrames.push(frame as ServerFrame);
      },
    });
    return () => {
      alive = false;
      forgetHelpers();
      forgetReasoning();
      clearTimeout(hydrationFallback);
      for (const refresh of peripheralRefresh.values()) {
        if (refresh.timer) clearTimeout(refresh.timer);
      }
      stopLive();
    };
  }, []);

  const refreshInstances = useCallback(async () => {
    try {
      const { instances } = await api("/api/instances");
      rawDispatch({ type: "instances", instances });
    } catch {}
  }, []);

  const refreshModels = useCallback(async (instanceId: string) => {
    const { instances } = await api(`/api/instances/${encodeURIComponent(instanceId)}/refresh-models`, {
      method: "POST",
    });
    rawDispatch({ type: "instances", instances });
  }, []);

  useEffect(() => {
    const back = () => {
      if (!personIsLooking()) return;
      const read = readWhenBack(stateRef.current);
      if (read) api(read.path, { method: "POST", ...(read.body ? { body: read.body } : {}) }).catch(() => {});
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, []);

  const lastFocusProbe = useRef(0);
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusProbe.current < 3000) return;
      lastFocusProbe.current = now;
      void refreshInstances();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshInstances]);

  const flushBotPatches = useCallback(
    (botId: string) => botPatchQueue.flush(botId),
    [botPatchQueue],
  );
  const value = useMemo(
    () => ({ state, dispatch, flushBotPatches, refreshInstances, refreshModels }),
    [state, dispatch, flushBotPatches, refreshInstances, refreshModels],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useOptionalStore() {
  return useContext(StoreContext);
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore outside provider");
  return ctx;
}

export function BotEditorStore({ value, children }: { value: ReturnType<typeof useStore>; children: ReactNode }) {
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function formatTime(at: number) {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "Invalid Date" : TIME_FORMAT.format(date);
}
