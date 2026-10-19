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
import { mainDogId } from "../../shared/main-dog";
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
import { botShowsUnread } from "@/lib/bot-unread";
import { personIsLooking, readWhenBack } from "@/lib/viewing";
import { jevRoomRoutingOn } from "@/lib/group-routing";
import { descendsFrom, newestTip } from "@/lib/leaf-follow";
import type { ComputerStart } from "@/lib/computer-start";
import { answerResponse, dismissResponse } from "@/lib/card-answer";
import { currentCall } from "@/lib/call";
import { desktopBanners, showNotification, type BannerReply, type NotificationTarget } from "@/lib/notify";
import { speaker } from "@/lib/tts";
import { createBotPatchQueue, type BotUpdatePatch } from "./bot-patch-queue";
import type { OnboardingStatus } from "@/lib/onboarding";
import { openLiveEvents, publishLiveFrame, publishMissedFrames } from "@/lib/live-events";
import { plainClientError, statusFallback } from "@/lib/plain-client-error";
import { HOME_WAKE_WORDS, WAKE_LIMIT_MS, WAKE_TOO_LONG, homeWake, retryAfterMs, wakeDelayMs, type HomeWake } from "../../shared/home-wake";
import type { OutboxItem, OutboxRecovery } from "@/lib/outbox";
import { createSendOutbox, type SendOutbox } from "./send-outbox";
import { receiveHelperEvent, receiveHelpersSnapshot, forgetHelpers } from "@/lib/helpers-state";
import { receiveReasoningEvent, forgetReasoning } from "@/lib/turn-reasoning";
import { readSessionState } from "@/lib/session";
import {
  FIRST_PAINT_SAVE_DELAY_MS, accountOf, firstPaintSnapshot, forgetFirstPaint, ownsFirstPaint, pageOrigin, readFirstPaint, saveFirstPaint, withFirstPaint,
  type FirstPaintSnapshot,
} from "@/lib/first-paint";

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
  profileRequest?: ProfileRequestCardData;
  modelRequest?: ModelRequestCardData;
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
  profile?: { name: string; email: string };
  language?: string;
  features?: { skillAuthoring: boolean; showToolCalls?: boolean; browser?: boolean; sharedComputers?: boolean; claudeUserMcp?: boolean; llmThreadTitles?: boolean; skillsLibrary?: boolean; cloudDictation?: boolean; typingSuggestions?: boolean; smarterSuggestions?: boolean; autoReview?: boolean };
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

export type AppSettingsSection = "general" | "computer" | "usage" | "updates";

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
  routines: Routine[];
  routineRuns: RoutineRun[];
  routinesLoadState: "loading" | "ready" | "error";
  settingsOpen: boolean;
  pluginsOpen: boolean;
  pluginsSurface: "apps" | "mcp";
  newBotOpen: boolean;
  botCreationPending: boolean;
  computerOpen: boolean;
  cloudTaskId: string | null;
  appSettingsOpen: boolean;
  appSettingsSection: AppSettingsSection;
  shortcutsOpen: boolean;
  welcomeOpen: boolean;
  botSettingsSection: BotSettingsSection;
  botSettingsExpandAccordion: boolean;
  computerStarts: Record<string, ComputerStart>;
  deletingBots: Record<string, true>;
  computerControl: Record<string, { held: boolean; helpReason: string | null }>;
  takeoverIntent: { botId: string; at: number } | null;
  focusMessage: { threadId: string; messageId: string; matchText?: string; nonce: number; consumed: boolean } | null;
  connected: boolean;
  hydrated?: boolean;
  restored?: boolean;
  error: string | null;
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
  | { type: "routinesHydrated"; routines: Routine[]; runs: RoutineRun[] }
  | { type: "routinesLoadFailed" }
  | { type: "routinePatched"; routine: Routine }
  | { type: "routineDeleted"; routineId: string }
  | { type: "routineRunPatched"; run: RoutineRun }
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
      recovery?: OutboxRecovery;
      onError?: () => void;
    }
  | {
      type: "patchGroup";
      groupId: string;
      patch: Partial<Pick<Group, "name" | "memberIds" | "defaultResponder" | "pinnedMessageId" | "section">>;
    }
  | { type: "deleteGroup"; groupId: string }
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
      recovery?: OutboxRecovery;
      onError?: () => void;
    }
  | { type: "pendingQueued"; threadId: string; queueId: string; text: string; reason?: SteerQueueReason }
  | { type: "consumePendingQueued"; threadId: string; queueId: string }
  | { type: "cancelQueued"; botId: string; queueId: string; threadId?: string; onCancelled?: () => void }
  | { type: "cancelGroupQueued"; groupId: string; threadId: string; queueId: string; onCancelled?: () => void }
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
      scope?: "once" | "always" | "chat" | "never";
      onError?: (message: string) => void;
    }
  | { type: "taskSwitched"; bot: Bot }
  | { type: "newBot"; name?: string; title?: string; avatarUrl?: string | null; avatarCrop?: Bot["avatarCrop"]; modelSelection?: ModelSelection; visibility?: BotVisibility; section?: string; offLeash?: boolean; preserveSelection?: boolean; onCreated?: (bot: Bot) => void; onError?: (message: string) => void }
  | { type: "botCreationPending"; on: boolean }
  | { type: "updateTask"; botId: string; threadId: string; patch: TaskUpdatePatch }
  | { type: "refreshTaskPermissions"; botId: string; threadId: string; acknowledgeLocalAuto?: boolean }
  | { type: "botAdded"; bot: Bot; preserveSelection?: boolean }
  | { type: "deleteBot"; botId: string }
  | { type: "botDeletionPending"; botId: string; on: boolean }
  | { type: "duplicateBot"; botId: string }
  | { type: "markUnread"; botId: string }
  | { type: "botPatched"; bot: BotAnnouncement }
  | { type: "messageAdded"; threadId: string; message: Message }
  | { type: "messagePatched"; threadId: string; message: Message }
  | { type: "reactionsSet"; threadId: string; messageId: string; reactions: Message["reactions"] }
  | { type: "optimisticMessageRemoved"; threadId: string; sendId: string }
  | { type: "outboxShown"; items: OutboxItem[] }
  | { type: "computerStart"; botId: string; start: ComputerStart | null }
  | { type: "computerControl"; botId: string; held: boolean; helpReason: string | null }
  | { type: "takeoverIntent"; intent: { botId: string; at: number } | null }
  | { type: "modelVariantRuntime"; event: RuntimeEvent }
  | { type: "setModel"; botId: string; selection: ModelSelection; threadId?: string; updateBotDefault?: boolean; resetApprovalToAsk?: boolean }
  | { type: "interrupt"; botId: string; threadId?: string; onError?: () => void }
  | { type: "connected"; value: boolean }
  | { type: "firstPaintDropped" }
  | { type: "error"; message: string | null }
  | { type: "toggleSettings"; open?: boolean; section?: BotSettingsSection; botId?: string }
  | { type: "togglePlugins"; open?: boolean; surface?: "apps" | "mcp" }
  | { type: "toggleNewBot"; open?: boolean }
  | { type: "toggleComputer"; open?: boolean }
  | { type: "openCloudTask"; jobId: string }
  | { type: "closeCloudTask" }
  | { type: "focusMessage"; threadId: string; messageId: string; matchText?: string }
  | { type: "focusMessageConsumed"; nonce: number }
  | { type: "toggleAppSettings"; open?: boolean; section?: AppSettingsSection }
  | { type: "toggleShortcuts"; open?: boolean }
  | { type: "toggleWelcome"; open?: boolean }
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
      !["send", "interrupt", "answerCard", "dismissCard", "cancelQueued"].includes(action.type)) return action;
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
  state: NotificationRoutingState & Pick<AppState, "selectedId">,
): string | null {
  return (
    state.bots.find((candidate) => candidate.id === state.selectedId)?.threadId ??
    state.groups.find((candidate) => candidate.id === state.selectedId)?.threadId ??
    null
  );
}

const ownsThread = (owner: NotificationThreadOwner, threadId: string) =>
  owner.threadId === threadId || (owner.tasks ?? []).some((task) => task.threadId === threadId);

function notificationOwner(target: NotificationTarget & { groupId?: string }, state: NotificationRoutingState) {
  const group = state.groups.find((candidate) => candidate.id === target.groupId) ??
    state.groups.find((candidate) => ownsThread(candidate, target.threadId));
  if (group) return { kind: "group" as const, id: group.id };
  const bot = state.bots.find((candidate) => ownsThread(candidate, target.threadId)) ??
    state.bots.find((candidate) => candidate.id === target.botId);
  return bot ? { kind: "bot" as const, id: bot.id } : null;
}

export function openNotificationTarget(
  dispatch: (action: Action) => void,
  target: NotificationTarget,
  state: NotificationRoutingState,
) {
  dispatch({ type: "select", id: notificationOwner(target, state)?.id ?? target.botId });
}

export function bannerReplyAction(reply: BannerReply, state: NotificationRoutingState): Action | null {
  const text = reply.text.trim();
  if (!text) return null;
  const owner = notificationOwner(reply, state);
  if (!owner) return null;
  return owner.kind === "group"
    ? { type: "sendGroup", groupId: owner.id, text, sendId: reply.sendId }
    : { type: "send", botId: owner.id, text, sendId: reply.sendId };
}

export interface ThreadTarget {
  botId: string;
  threadId: string;
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
  };
}

function showHeldSend(state: AppState, item: OutboxItem): AppState {
  if (!item.threadId) return state;
  const bot = state.bots.find((candidate) => candidate.threadId === item.threadId);
  if (bot) {
    if (bot.messages.some((message) => message.sendId === item.sendId)) return state;
    const message = { ...optimisticUserMessage(item.text, item.sendId, item.replyToId, bot.activeLeafId), at: item.queuedAt };
    return updateBot(state, bot.id, (current) => ({ ...current, messages: [...current.messages, message], activeLeafId: message.id }));
  }
  const group = state.groups.find((candidate) => candidate.threadId === item.threadId);
  if (!group || group.messages.some((message) => message.sendId === item.sendId)) return state;
  const message = {
    ...optimisticUserMessage(item.text, item.sendId, item.replyToId, null),
    at: item.queuedAt,
  };
  return {
    ...state,
    groups: state.groups.map((candidate) => candidate.id === group.id ? { ...candidate, messages: [...candidate.messages, message] } : candidate),
  };
}

export const CLOUD_LINK_SETTINGS = { type: "toggleAppSettings", open: true, section: "general" } as const satisfies Action;
export const LENDING_SETTINGS = { type: "toggleAppSettings", open: true, section: "computer" } as const satisfies Action;

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
        state.selectedId && known(state.selectedId) ? state.selectedId : (mainDogId(action.bots) ?? "");
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
      const selectedId = state.selectedId === action.groupId ? (mainDogId(state.bots) ?? "") : state.selectedId;
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
          selectedId: action.id,
          botSettingsSection: action.id !== state.selectedId ? "overview" : state.botSettingsSection,
          groups: state.groups.map((g) => (g.id === action.id ? { ...g, unread: false } : g)),
        };
      }
      return updateBot(
        withMascotMotion(
          {
            ...state,
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
        ...(action.preserveSelection ? {} : { selectedId: action.bot.id }),
      }, action.bot.id, "arrive");
    case "deleteBot": {
      const bots = state.bots.filter((b) => b.id !== action.botId);
      const selectedId =
        state.selectedId === action.botId ? (mainDogId(bots) ?? "") : state.selectedId;
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
            bots: animated.bots.map((b) => b.id === action.bot.id ? b : { ...b, chiefOfStaff: false }),
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
    case "outboxShown":
      return action.items.reduce(showHeldSend, state);
    case "optimisticMessageRemoved": {
      const id = optimisticMessageId(action.sendId);
      const bot = state.bots.find((candidate) => candidate.threadId === action.threadId);
      if (bot) {
        const optimistic = bot.messages.find((message) => message.id === id);
        if (!optimistic) return state;
        const cleared = updateBot(state, bot.id, (current) => {
          const messages = current.messages.filter((message) => message.id !== id);
          const restored = optimistic.parentId ?? null;
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
    case "reactionsSet": {
      const react = (messages: Message[]) => messages.map((m) => (m.id === action.messageId ? { ...m, reactions: action.reactions } : m));
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (bot) return updateBot(state, bot.id, (b) => ({ ...b, messages: react(b.messages) }));
      if (!state.groups.some((g) => g.threadId === action.threadId)) return state;
      return { ...state, groups: state.groups.map((g) => (g.threadId === action.threadId ? { ...g, messages: react(g.messages) } : g)) };
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
    case "firstPaintDropped":
      return state.hydrated || !state.restored
        ? state
        : { ...state, restored: false, bots: [], groups: [], sections: [], selectedId: "" };
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
        botSettingsSection: action.section ?? (selectedId !== state.selectedId ? "overview" : state.botSettingsSection),
        botSettingsExpandAccordion: open ? action.section !== undefined : false,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        takeoverIntent: open ? state.takeoverIntent : null,
      };
    }
    case "togglePlugins": {
      const open = action.open ?? !state.pluginsOpen;
      return {
        ...state,
        pluginsOpen: open,
        pluginsSurface: action.surface ?? state.pluginsSurface,
        ...(open ? { settingsOpen: false, appSettingsOpen: false, newBotOpen: false, shortcutsOpen: false } : {}),
      };
    }
    case "botCreationPending":
      return { ...state, botCreationPending: action.on };
    case "toggleNewBot": {
      const open = action.open ?? !state.newBotOpen;
      return {
        ...state, newBotOpen: open,
        ...(open ? { settingsOpen: false, appSettingsOpen: false, pluginsOpen: false, shortcutsOpen: false } : {}),
      };
    }
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
        settingsOpen: open ? false : state.settingsOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "toggleAppSettings": {
      const open = action.open ?? !state.appSettingsOpen;
      return {
        ...state,
        appSettingsOpen: open,
        appSettingsSection: action.section ?? state.appSettingsSection,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        pluginsOpen: open ? false : state.pluginsOpen,
      };
    }
    case "toggleShortcuts": {
      const open = action.open ?? !state.shortcutsOpen;
      return {
        ...state,
        shortcutsOpen: open,
      };
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
      const next = action.patch.chiefOfStaff
        ? {
            ...animated,
            bots: animated.bots.map((b) => b.id === action.botId ? b : { ...b, chiefOfStaff: false }),
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
    case "interrupt":
    case "createGroup":
    case "deleteGroup":
    case "interruptGroup":
    case "createRoutine":
    case "updateRoutine":
    case "deleteRoutine":
    case "runRoutine":
    case "cancelRoutineRun":
    case "refreshTaskPermissions":
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
  routines: [],
  routineRuns: [],
  routinesLoadState: "loading",
  settingsOpen: false,
  pluginsOpen: false,
  pluginsSurface: "apps",
  newBotOpen: false,
  botCreationPending: false,
  computerOpen: false,
  cloudTaskId: null,
  appSettingsOpen: false,
  appSettingsSection: "general",
  shortcutsOpen: false,
  welcomeOpen: false,
  botSettingsSection: "overview",
  botSettingsExpandAccordion: false,
  computerStarts: {},
  deletingBots: {},
  computerControl: {},
  takeoverIntent: null,
  focusMessage: null,
  connected: false,
  error: null,
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
  readonly wake?: HomeWake;
  readonly retryAfterMs?: number;
  constructor(message: string, status: number, body?: Record<string, unknown>, home?: { wake?: HomeWake | null; retryAfterMs?: number | null }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    if (home?.wake) this.wake = home.wake;
    if (home?.retryAfterMs) this.retryAfterMs = home.retryAfterMs;
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


export type ApiInit = RequestInit & { timeoutMs?: number; rideWake?: boolean };

const sleepUnlessAborted = (ms: number, signal: AbortSignal | null | undefined) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener?.("abort", stop, { once: true });
  });

export async function api<T = any>(path: string, init?: ApiInit): Promise<T> {
  const { timeoutMs, signal, rideWake, ...rest } = init ?? {};
  const bounded = timeoutMs === undefined
    ? signal
    : signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
  const started = Date.now();
  for (;;) {
    const res = await fetch(path, {
      headers: { "content-type": "application/json" },
      ...rest,
      signal: bounded,
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    const wake = homeWake(res.status, res.headers);
    const waitMs = retryAfterMs(res.headers, body);
    if (wake && rideWake !== false && (rest.body == null || typeof rest.body === "string")) {
      const delay = wakeDelayMs(wake, waitMs);
      if (Date.now() - started + delay <= WAKE_LIMIT_MS) {
        await sleepUnlessAborted(delay, bounded);
        continue;
      }
      throw new ApiError(WAKE_TOO_LONG, res.status, body, { wake, retryAfterMs: waitMs });
    }
    const message = wake ? HOME_WAKE_WORDS[wake] : typeof body.error === "string" && body.error ? body.error : statusFallback(res.status);
    throw new ApiError(message, res.status, body, { wake, retryAfterMs: waitMs });
  }
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
  const firstPaint = useRef<FirstPaintSnapshot | null | undefined>(undefined);
  if (firstPaint.current === undefined) firstPaint.current = readFirstPaint(pageOrigin());
  const [state, rawDispatch] = useReducer(reducer, initialState, (base) =>
    firstPaint.current ? withFirstPaint(base, firstPaint.current) : base);
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

  const sendOutboxRef = useRef<SendOutbox | null>(null);
  const sendOutbox = useCallback(() => {
    sendOutboxRef.current ??= createSendOutbox({
      request: api,
      dispatch: rawDispatch,
      showError: (error) => {
        rawDispatch({ type: "error", message: plainClientError(error) });
        setTimeout(() => rawDispatch({ type: "error", message: null }), 6000);
      },
    });
    return sendOutboxRef.current;
  }, []);

  useEffect(() => {
    const resume = () => sendOutbox().resume();
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    return () => {
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
      sendOutboxRef.current?.dispose();
      sendOutboxRef.current = null;
    };
  }, [sendOutbox]);

  const dispatch = useMemo(() => {
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
      if ((action.type === "send" || action.type === "sendGroup") && !action.sendId) {
        action = { ...action, sendId: crypto.randomUUID() };
      }
      const botBeforeUpdate =
        action.type === "updateBot" || action.type === "setModel"
          ? stateRef.current.bots.find((candidate) => candidate.id === action.botId)
          : undefined;
      const botBeforeSend =
        action.type === "send"
          ? stateRef.current.bots.find((candidate) => candidate.id === action.botId)
          : undefined;
      const executionBotsBeforeAction = (() => {
        if (action.type === "answerCard") {
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
        case "cancelGroupQueued":
          void api(`/api/groups/${action.groupId}/queue/${action.queueId}`, { method: "DELETE" })
            .then(() => {
              rawDispatch(action);
              action.onCancelled?.();
            })
            .catch(showError);
          break;
        case "send": {
          if (quizBeforeSend) persistCard(action.botId, quizBeforeSend.id, { dismissed: true });
          const threadId =
            action.threadId ?? stateRef.current.bots.find((bot) => bot.id === action.botId)?.threadId;
          sendOutbox().send({
            sendId: action.sendId ?? crypto.randomUUID(),
            threadId: threadId ?? "",
            target: { kind: "bot", botId: action.botId, ...(action.deliver ? { deliver: action.deliver } : {}) },
            text: action.text,
            ...(action.replyToId ? { replyToId: action.replyToId } : {}),
            queuedAt: Date.now(),
            ...(action.recovery ? { recovery: action.recovery } : {}),
          }, {
            ready: waitForExecutionSettings(botBeforeSend ? [botBeforeSend] : [], threadId),
            onError: action.onError,
          });
          break;
        }
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
                defaultResponder: jevRoomRoutingOn(stateRef.current.config)
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
          sendOutbox().send({
            sendId: action.sendId ?? crypto.randomUUID(),
            threadId: threadId ?? "",
            target: { kind: "group", groupId: action.groupId },
            text: action.text,
            ...(action.replyToId ? { replyToId: action.replyToId } : {}),
            queuedAt: Date.now(),
            ...(action.recovery ? { recovery: action.recovery } : {}),
          }, {
            ready: waitForExecutionSettings(executionBotsBeforeAction),
            onError: action.onError,
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
        case "interrupt":
          api(`/api/bots/${action.botId}/interrupt`, {
            method: "POST",
            body: action.threadId ? JSON.stringify({ threadId: action.threadId }) : undefined,
          }).catch((error) => {
            showError(error);
            action.onError?.();
          });
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
  }, [botPatchQueue, sendOutbox]);

  useEffect(() => {
    let alive = true;
    type PeripheralKey = "instances" | "config" | "routines" | "helpers";
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
          const outbox = sendOutbox();
          const pending = outbox.pending(bots ?? [], groups ?? [], botQueuedMessages);
          if (pending.length > 0) rawDispatch({ type: "outboxShown", items: pending });
          outbox.resume();
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
      }
      switch (frame.kind) {
        case "sections":
          rawDispatch({ type: "sections", sections: frame.sections });
          break;
        case "bot.queued":
          sendOutbox().queued(frame.queues);
          rawDispatch({ type: "botQueues", queues: frame.queues });
          break;
        case "message": {
          rawDispatch({ type: "messageAdded", threadId: frame.threadId, message: frame.message as Message });
          if (frame.message?.role === "user" && typeof frame.message.sendId === "string") sendOutbox().echoed(frame.message.sendId);
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
          if (bot.id === stateRef.current.selectedId && personIsLooking() &&
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
      onOpen: () => {
        rawDispatch({ type: "connected", value: true });
        sendOutbox().resume();
      },
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
  }, [sendOutbox]);

  const firstPaintAccount = useRef<Promise<string | null> | null>(null);
  const knownAccount = useRef<string | null | undefined>(undefined);
  const knowAccount = useCallback(() => {
    firstPaintAccount.current ??= readSessionState().then((session) => {
      if (session.kind === "unreachable") {
        firstPaintAccount.current = null;
        return null;
      }
      const account = accountOf(session);
      knownAccount.current = account;
      const restored = firstPaint.current;
      if (restored && !ownsFirstPaint(restored, { origin: pageOrigin() ?? "", account: account ?? "" })) {
        firstPaint.current = null;
        forgetFirstPaint();
        rawDispatch({ type: "firstPaintDropped" });
      }
      return account;
    });
    return firstPaintAccount.current;
  }, []);
  const writeFirstPaint = useCallback((account: string | null | undefined) => {
    const current = stateRef.current;
    const origin = pageOrigin();
    if (!current.hydrated || account === undefined || !origin) return;
    const serialized = account ? firstPaintSnapshot(current, { origin, account }, Date.now()) : null;
    if (serialized) saveFirstPaint(serialized);
    else forgetFirstPaint();
  }, []);

  useEffect(() => {
    void knowAccount();
  }, [knowAccount]);

  useEffect(() => {
    if (!state.hydrated) return;
    const timer = setTimeout(() => {
      void knowAccount().then(() => writeFirstPaint(knownAccount.current));
    }, FIRST_PAINT_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state.hydrated, state.bots, state.groups, state.sections, state.selectedId, knowAccount, writeFirstPaint]);

  useEffect(() => {
    const flush = () => writeFirstPaint(knownAccount.current);
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [writeFirstPaint]);

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

  useEffect(() => {
    const banners = desktopBanners();
    if (!banners) return;
    const stopOpen = banners.onOpen((target) => openNotificationTarget(dispatch, target, stateRef.current));
    const stopReply = banners.onReply((reply) => {
      const action = bannerReplyAction(reply, stateRef.current);
      if (action) dispatch(action);
    });
    return () => {
      stopOpen();
      stopReply();
    };
  }, [dispatch]);

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
