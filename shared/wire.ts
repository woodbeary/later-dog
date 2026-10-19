import type { ApprovalMode } from "./approval-mode.ts";
import type { ToolScope } from "./tool-scope.ts";
import type { CommandAllowlistCandidate } from "./command-allowlist.ts";
import type { TurnDigest } from "./digest.ts";
import type { BotAvatarCrop } from "./bot-avatar.ts";
import type { MascotBodyId } from "./mascot-bodies.ts";
import type { CredentialTargetId } from "./credential-request.ts";
import type { RoutineRequestCardData } from "./routine-request.ts";
import type { ProfileRequestCardData } from "./profile-request.ts";
import type { PlaceRow } from "./place-view.ts";
import type { FailedTurnQuota } from "./failed-turn.ts";
import type { ModelRequestCardData } from "./model-request.ts";
import type { SkillRequestCardData } from "./skill-request.ts";
import type { QuestionRequestCardData } from "./ask-question.ts";
import type { TakeoverRequestCardData } from "./takeover.ts";
import type { SecureFormCardData } from "./secure-form.ts";
import type { RoutineRunCardData } from "./routine-run.ts";
import type { RuntimeEvent } from "./runtime-events.ts";
import type { Notification } from "./notification.ts";
import type { Routine, RoutineRun } from "./routines.ts";
import type { WebhookAttempt, WebhookTrigger } from "./webhooks.ts";

export const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  effort?: EffortLevel;
  variant?: string;
  fast?: boolean;
}

export type CloudBackend = "box" | "vps";

export type Surface = "cloud" | "vm" | "local" | "browser";

export type DogColor =
  | "green" | "blue" | "red" | "orange" | "purple" | "cyan" | "pink"
  | "yellow" | "teal" | "coral";

export type DogExpression = string;

export type BotActivity = "working" | "waiting-on-you" | "idle" | "no-signal" | "dead" | "parked.computer";

export interface TaskOpenedBy {
  botId: string;
  name: string;
  delegationId?: string;
  kind?: "pair" | "work";
  threadId?: string;
  at: number;
}

export interface TaskClosedBy {
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

export interface GroupThreadUsage extends TaskUsage {
  lastSpeaker?: { botId: string; name: string };
}

export interface WireTask {
  waitingForTeammates?: boolean;
  threadId: string;
  title: string;
  createdAt: number;
  titleFromFirstMessage?: true;
  projectId?: string;
  routineRunId?: string;
  openedBy?: TaskOpenedBy;
  closedBy?: TaskClosedBy;
  archivedAt?: number;
  pinned?: boolean;
  updatedAt?: number;
  snoozedUntil?: number;
  modelSelection?: ModelSelection;
  followsBotModel?: boolean;
  approvalMode?: ApprovalMode;
  autoApprove?: boolean;
  alwaysAllow?: string[];
  unread?: boolean;
  rewound?: boolean;
  pinnedMessageId?: string;
  activity?: BotActivity;
  busy?: boolean;
  turnStartedAt?: number;
  workingStartedAt?: number;
  statusLine?: string;
  surface?: Surface;
  surfaceAuto?: true;
  usage?: TaskUsage;
  cwd?: string | null;
}

export interface BotProject {
  id: string;
  name: string;
  emoji?: string;
}

export interface InstalledPlaybook {
  key: string;
  name: string;
  summary: string;
  triggers: string[];
  instructions: string;
}

export interface InstalledPackageMetadata {
  id: string;
  name: string;
  release: string;
  requiredApps: Array<{ slug: string; label: string; reason: string; optional?: boolean }>;
  source?: "file" | "org";
  installId?: string;
  agentKey?: string;
  presetKey?: string;
  suggestedApproval?: "ask" | "auto";
  publisher?: { organizationId: string; slug: string; name: string };
  ref?: string;
  sha256?: string;
}

export interface ConnectorToolGrant {
  tools: "*" | string[];
}

export const CONNECTOR_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,80}$/;
export const CONNECTOR_TOOL_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

export interface WireBot {
  waitingForTeammates?: boolean;
  id: string;
  threadId: string;
  tasks?: WireTask[];
  projects?: BotProject[];
  name: string;
  formerNames?: string[];
  title: string;
  description: string;
  soul?: string;
  soulHash?: string;
  soulDrift?: boolean;
  notifications: boolean;
  color: DogColor;
  mascotExpression?: DogExpression | null;
  mascotBody?: MascotBodyId | null;
  avatarUrl: string | null;
  avatarCrop?: BotAvatarCrop;
  avatarZoom?: number;
  avatarFocusX?: number;
  avatarFocusY?: number;
  unread: boolean;
  modelSelection: ModelSelection;
  computer?: Surface | "off";
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
  parkDirectMessages?: boolean;
  rewound?: boolean;
  pinned?: boolean;
  hidden?: boolean;
  section?: string;
  pinnedMessageId?: string;
  chiefOfStaff?: boolean;
  approvePeerComms?: boolean;
  peers?: string[];
  composio?: boolean;
  connectorTools?: Record<string, ConnectorToolGrant>;
  fallback?: Array<{ instanceId: string; model: string }>;
  browser?: boolean;
  memoryUpkeep?: boolean;
  mcpServers?: string[];
  toolScope?: ToolScope;
  browserProfile?: string;
  playbooks?: InstalledPlaybook[];
  installedPackage?: InstalledPackageMetadata;
  busy?: boolean;
  activity?: BotActivity;
  createdAt: number;
  visibility?: BotVisibility;
}

export type BotVisibility = "everyone" | "admins" | { people: string[] };

export interface ResolvedSender {
  name: string;
  id?: string;
}

export type CardAnswerer = (
  | { kind: "session"; name: string; person?: string }
  | { kind: "loopback" }
  | { kind: "worker" }
) & {
  via?: "call";
};

export interface WireMessage {
  roomRequest?: { id: string; phase: "request" | "result" };
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen" | "connector" | "secret" | "routine.run" | "goal.run" | "digest" | "compaction";
  text?: string;
  digest?: TurnDigest;
  compaction?: {
    summary: string;
    firstKeptId: string;
    foldedThroughId: string;
    tokensBefore: number;
    by: "person" | "harness";
  };
  attachments?: Array<
    | { kind: "image"; path: string; mime: string }
    | { kind: "file"; path: string; mime: string; name: string }
    | { kind: "audio"; path: string; mime: string; durationMs?: number }
  >;
  card?: OptionCardData;
  connector?: ConnectorCardData;
  secret?: SecretRequestCardData;
  secureForm?: SecureFormCardData;
  routineRun?: RoutineRunCardData;
  tool?: {
    name: string; ok?: boolean; spoken?: string; setup?: boolean; terminal?: boolean; summary?: string; input?: string; output?: string;
    claudeUpdate?: boolean;
    place?: PlaceRow;
    quota?: FailedTurnQuota;
    carry?: { from: string; to: string };
    resume?: { handoffId: string };
    itemId?: string;
    fullResult?: boolean;
    statusLine?: "live" | "folded";
    pickup?: "restart";
  };
  webhookPost?: boolean;
  ownersRoutine?: boolean;
  steered?: boolean;
  aside?: boolean;
  via?: "api" | "call";
  relayed?: boolean;
  sender?: ResolvedSender;
  turnId?: string;
  requestMessageId?: string;
  turnSucceeded?: boolean;
  requestCancelled?: boolean;
  requestPending?: boolean;
  turnTerminal?: boolean;
  png?: string;
  mime?: string;
  at: number;
  parentId?: string | null;
  replyToId?: string;
  sendId?: string;
  from?: { botId: string; name: string; color: string };
  peerPost?: { unattended?: boolean };
  routedBy?: { provider: "jev"; probability: number };
  peerAsk?: { botId: string; name: string; unattended?: boolean };
  reactions?: Array<{ emoji: string; by: string }>;
  comm?: { groupId: string; threadId?: string; withBotId: string; withName: string; withColor: string; direction?: "to" | "from" };
  threadRef?: { botId: string; threadId: string; title: string };
  cloudTask?: import("./cloud-task.ts").CloudTaskRef;
  queued?: boolean;
  queueId?: string;
}

export interface OptionCardData {
  outboundRequest?: { tool: string; app: string | null; calls?: Array<{ app: string | null; label: string }> };
  title: string;
  subtitle: string;
  options: string[];
  requestType?: "permission" | "question";
  answered?: string;
  answeredText?: string;
  dismissed?: boolean;
  answeredBy?: CardAnswerer;
  requestId?: string;
  tool?: string;
  held?: string;
  expired?: boolean;
  heldCode?: string;
  allowKey?: string;
  allowSession?: boolean;
  answerScope?: "once" | "always" | "chat";
  commandAllowlist?: CommandAllowlistCandidate;
  approvalScope?: "local-computer";
  autoApplied?: boolean;
  undone?: boolean;
  routineRequest?: RoutineRequestCardData;
  profileRequest?: ProfileRequestCardData;
  modelRequest?: ModelRequestCardData;
  skillRequest?: SkillRequestCardData;
  questionRequest?: QuestionRequestCardData;
  takeoverRequest?: TakeoverRequestCardData;
}

export type LiveClient = "desktop" | "web" | "ios" | "android";
export type LiveCallStatus = "connecting" | "live" | "ending" | "ended";
export type LiveEndReason =
  | "hung-up" | "idle" | "expired" | "content" | "remote-hangup" | "connection-lost"
  | "sideband-lost" | "deleted" | "shutdown" | "signed-out" | "error";

export interface LiveCallState {
  callId: string;
  botId: string;
  threadId: string;
  client: LiveClient;
  voice: string;
  startedAt: number;
  status: LiveCallStatus;
  endReason?: LiveEndReason;
  error?: string;
}

export interface LiveSettings {
  configured: boolean;
  voice: string;
  readTypedReplies: boolean;
  idleMinutes: number;
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
  target: CredentialTargetId;
  label: string;
  description: string;
  placeholder: string;
  helpUrl: string;
  requestKey: string;
  phoneOperationId?: string;
  provided?: boolean;
  dismissed?: boolean;
  superseded?: boolean;
  resumed?: boolean;
  error?: string;
}

export type GroupDefaultResponder =
  | { kind: "member"; botId: string }
  | { kind: "everyone" }
  | { kind: "mentions" }
  | { kind: "auto"; fallbackBotId?: string };

export interface GroupTask {
  threadId: string;
  title: string;
  createdAt: number;
  pinnedCwd?: string | null;
  pinnedMessageId?: string;
  pinned?: boolean;
  turnTimeoutMinutes?: number;
  updatedAt?: number;
  titleFromFirstMessage?: true;
}

export interface WireGroup {
  usage?: GroupThreadUsage | null;
  id: string;
  threadId: string;
  tasks?: GroupTask[];
  name: string;
  memberIds: string[];
  defaultResponder: GroupDefaultResponder;
  bulletin: string;
  unread: boolean;
  createdAt: number;
  dm?: boolean;
  busyBotId?: string | null;
  turnStartedAt?: number;
  cwd?: string;
  pinnedCwd?: string | null;
  pinnedMessageId?: string;
  section?: string;
  setupCompletedAt?: number | null;
  setupSkippedAt?: number | null;
  audienceFloor?: BotVisibility;
  working: boolean;
  turnTimeoutMinutes?: number | null;
}


export type SteerQueueReason = "capacity" | "group-turn";

export type BotQueuedMessages = Record<string, Array<{ queueId: string; text: string; sendId?: string; reason?: SteerQueueReason }>>;

export interface SkillsLibrarySkillWire {
  name: string;
  description: string;
  source: string;
  enabled: boolean;
  tags: string[];
  version: string | null;
  importedAt: string;
  license?: string;
  compatibility?: string;
  warnings: string[];
  assignedBots: Array<{ id: string; name: string }>;
}

export interface BotAssignedSkillsWire {
  skills: string[];
}

export type ServerFrame =
  | { kind: "sections"; sections: string[] }
  | { kind: "bot.queued"; queues: BotQueuedMessages }
  | { kind: "message"; threadId: string; message: WireMessage }
  | { kind: "message.patch"; threadId: string; message: WireMessage }
  | { kind: "thread"; threadId: string; activeLeafId: string }
  | { kind: "bot"; bot: WireBot }
  | { kind: "group"; group: WireGroup }
  | { kind: "notify"; notification: Notification }
  | { kind: "group.deleted"; groupId: string }
  | { kind: "routine"; routine: Routine }
  | { kind: "routine.deleted"; routineId: string }
  | { kind: "routine.run"; run: RoutineRun }
  | { kind: "webhook"; webhook: WebhookTrigger }
  | { kind: "webhook.attempt"; attempt: WebhookAttempt }
  | { kind: "webhook.deleted"; webhookId: string }
  | { kind: "runtime"; event: RuntimeEvent }
  | { kind: "screen"; botId: string; threadId: string; png: string; mime?: string }
  | { kind: "computer"; botId: string; state: "provisioning" | "waking"; place?: "cloud" }
  | { kind: "computer-control"; botId: string; held: boolean; helpReason: string | null }
  | { kind: "bot.deleted"; botId: string }
  | { kind: "live.call"; botId: string; threadId: string; call: LiveCallState | null }
  | ({ kind: "config" } & Record<string, unknown>);
