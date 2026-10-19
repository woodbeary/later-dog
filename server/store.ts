import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic, writeFileAtomicIfChanged } from "./atomic.ts";
import { parseToolScope, toolScopeWidens } from "../shared/tool-scope.ts";
import { ensureSections, readSections, changeEmptySection, orderSections } from "./section-context.ts";
import type { TeamComputers } from "./team-computers.ts";
import { removeBotFolder, soulFile, soulHash, writeSoulMirror } from "./bot-folder.ts";
import type { BotProfilePatch } from "./bot-profile.ts";
import { peerAllowKey, type PeerAction } from "./peer-approval-key.ts";
import { DATA_DIR, EVENTS_DIR, NATIVE_DIR, loadBrowserProfileIdAliases } from "./config.ts";
import * as mdb from "./message-db.ts";
import { runCommand, type Command } from "./commands.ts";
import { workspaceDir } from "./workspace.ts";
import type { Destination } from "./surface.ts";
import { retirePlaces } from "./laterdog/places.ts";
import { newId, type ModelSelection } from "./contracts.ts";
import { pickBotName } from "./names.ts";
import { redactSecretsInText } from "./redact.ts";
import { AVATAR_FOCUS_CENTER, AVATAR_ZOOM_MIN, botAvatarProfile, clampAvatarFocus, clampAvatarZoom } from "../shared/bot-avatar.ts";
import { approvalModeFor, isApprovalMode, modelSwitchNeedsAsk } from "../shared/approval-mode.ts";
import { REMOVED_COMPUTER_DRIVER, type ComputerEngineMove } from "./computer-engine-removal.ts";
import type { ProfileRequestChanges } from "../shared/profile-request.ts";
import { mainDogId } from "../shared/main-dog.ts";
import { isMentionBoundary, isMentionNameContinuation } from "../shared/mention-boundary.ts";
import type { HandedState } from "./delta-context.ts";
import type { AgentPart, PartPair, RoomPart } from "./package-parts.ts";
import type {
  BotActivity, GroupDefaultResponder, GroupTask as GroupTaskRecord, DogColor,
  ConnectorToolGrant, OptionCardData, TaskClosedBy, TaskOpenedBy, TaskUsage, WireBot, WireGroup,
  WireMessage, WireTask, BotProject as BotProjectRecord,
} from "../shared/wire.ts";
import { CONNECTOR_SLUG_PATTERN, CONNECTOR_TOOL_NAME_PATTERN } from "../shared/wire.ts";
import { sameModelSelection } from "../shared/thread-model.ts";
import { exchangeName, formerNamesAfterRename } from "./laterdog/former-names.ts";
import { readOwnedJson } from "./laterdog/owned-file.ts";
import type { DamagedData } from "../shared/damaged-data.ts";
export type {
  BotActivity, ConnectorCardData, GroupDefaultResponder, OptionCardData,
  SecretRequestCardData, Surface, TaskClosedBy, TaskOpenedBy, TaskUsage,
} from "../shared/wire.ts";
export type { GroupTask as GroupTaskRecord, BotProject as BotProjectRecord } from "../shared/wire.ts";
export type { InstalledPlaybook, InstalledPackageMetadata, DogColor, DogExpression } from "../shared/wire.ts";


export type Message = WireMessage;

export interface GroupPackageStamp {
  installId: string;
  key: string;
  memberKeys: string[];
  parts: Record<RoomPart, PartPair>;
}

export type GroupRecord = Omit<WireGroup, "working" | "usage"> & { installedPackage?: GroupPackageStamp };
export type GroupWirePrivateKeys = "installedPackage";
export type GroupWireProjection = Omit<GroupRecord, GroupWirePrivateKeys> & Pick<WireGroup, "usage"> & { working: boolean };
export type GroupWireProjectionIsExact = AssertExact<WireGroup, GroupWireProjection> & AssertSameKeys<WireGroup, GroupWireProjection>;
export const groupWireProjectionIsExact: GroupWireProjectionIsExact = true;

const projectEmojiPattern = new RegExp("^(?!\\p{Emoji_Component}$)(?:\\p{RGI_Emoji}|[\\p{Emoji}--\\p{Emoji_Component}])$", "v");
export function isProjectEmoji(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && projectEmojiPattern.exec(value)?.[0] === value;
}

export interface TaskRecord extends Omit<WireTask, TaskWireDerivedKeys> {
  resumeCursors: Record<string, unknown>;
  lastInstanceId?: string;
  handedMessages?: Record<string, HandedState>;
  appliedCompactionId?: string;
  contextFloor?: number;
  lastContextModel?: string;
  surfaceSource?: "user" | "auto";
}

export type TaskWirePrivateKeys = "resumeCursors" | "lastInstanceId" | "handedMessages" | "appliedCompactionId" | "contextFloor" | "lastContextModel" | "surfaceSource";
export type TaskWireDerivedKeys = "surfaceAuto" | "followsBotModel";
export type TaskWireProjection = Pick<TaskRecord, Exclude<keyof TaskRecord, TaskWirePrivateKeys>> & Pick<WireTask, TaskWireDerivedKeys>;
type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type AssertSameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : never) : never;
export type TaskWireProjectionIsExact = AssertExact<WireTask, TaskWireProjection> & AssertSameKeys<WireTask, TaskWireProjection>;
export const taskWireProjectionIsExact: TaskWireProjectionIsExact = true;

export function toWireTask(task: TaskRecord, botModel: ModelSelection, bots: readonly Pick<WireBot, "id" | "name" | "hidden">[] = []): WireTask {
  const { resumeCursors: _resumeCursors, lastInstanceId: _lastInstanceId, handedMessages: _handedMessages,
    appliedCompactionId: _appliedCompactionId, contextFloor: _contextFloor, lastContextModel: _lastContextModel,
    surfaceSource, ...stored } = task;
  const currentName = (ref: { botId: string; name: string }) => bots.find((bot) => bot.id === ref.botId && !bot.hidden)?.name ?? ref.name;
  const openedBy = stored.openedBy && { ...stored.openedBy, name: currentName(stored.openedBy) };
  const closedBy = stored.closedBy && { ...stored.closedBy, name: currentName(stored.closedBy) };
  const title = stored.openedBy?.kind === "work" && stored.title === `@${stored.openedBy.name} · work`
    ? `@${openedBy!.name} · work` : stored.title;
  const wire: WireTask = { ...stored, title, ...(openedBy ? { openedBy } : {}), ...(closedBy ? { closedBy } : {}), modelSelection: structuredClone(task.modelSelection ?? botModel), followsBotModel: task.modelSelection === undefined };
  return surfaceSource === "auto" && wire.surface !== undefined ? { ...wire, surfaceAuto: true } : wire;
}

const ASK_NOW = { approvalMode: "ask" as const, autoApprove: false, alwaysAllow: [] as string[] };

const TASK_PATCH_FIELDS = [
  "title", "projectId", "modelSelection", "approvalMode", "autoApprove", "alwaysAllow",
  "unread", "rewound", "archivedAt", "pinned", "pinnedMessageId", "resumeCursors", "lastInstanceId", "cwd",
  "routineRunId", "surface", "surfaceSource", "snoozedUntil", "appliedCompactionId", "contextFloor", "lastContextModel",
] as const satisfies readonly (keyof TaskRecord)[];
export type TaskPatch = Partial<Pick<TaskRecord, typeof TASK_PATCH_FIELDS[number]>>;

function persistedPin<T extends { pinned?: boolean }>(task: T): T {
  if (task.pinned === true) return task;
  if (!("pinned" in task)) return task;
  const { pinned: _pinned, ...rest } = task;
  return rest as T;
}

function redactBotAuthored<T extends Omit<Message, "id" | "at"> & { at?: number }>(message: T): T {
  if (message.role !== "bot") return message;
  const out = { ...message };
  if (typeof out.text === "string") out.text = redactSecretsInText(out.text);
  if (out.compaction) out.compaction = { ...out.compaction, summary: redactSecretsInText(out.compaction.summary) };
  if (out.tool?.name) {
    out.tool = { ...out.tool, name: redactSecretsInText(out.tool.name) };
    if (out.tool.summary) out.tool.summary = redactSecretsInText(out.tool.summary);
  }
  if (out.routineRun) {
    const routineRun = { ...out.routineRun };
    routineRun.routineName = redactSecretsInText(routineRun.routineName);
    if (routineRun.summary) routineRun.summary = redactSecretsInText(routineRun.summary);
    if (routineRun.error) routineRun.error = redactSecretsInText(routineRun.error);
    out.routineRun = routineRun;
  }
  if (out.card) {
    const card = { ...out.card } as OptionCardData & { summary?: string };
    card.title = redactSecretsInText(card.title);
    if (typeof card.subtitle === "string") card.subtitle = redactSecretsInText(card.subtitle);
    if (typeof card.summary === "string") card.summary = redactSecretsInText(card.summary);
    if (typeof card.held === "string") card.held = redactSecretsInText(card.held);
    if (typeof card.answeredText === "string") card.answeredText = redactSecretsInText(card.answeredText);
    if (card.commandAllowlist && (
      redactSecretsInText(card.commandAllowlist.command) !== card.commandAllowlist.command ||
      redactSecretsInText(card.commandAllowlist.cwd) !== card.commandAllowlist.cwd
    )) delete card.commandAllowlist;
    if (card.questionRequest) {
      card.questionRequest = {
        ...card.questionRequest,
        questions: card.questionRequest.questions.map((question) => ({
          ...question,
          question: redactSecretsInText(question.question),
          ...(question.header ? { header: redactSecretsInText(question.header) } : {}),
          options: question.options.map((option) => ({
            ...option,
            label: redactSecretsInText(option.label),
            ...(option.description ? { description: redactSecretsInText(option.description) } : {}),
          })),
        })),
      };
    }
    if (card.routineRequest) {
      const operation = card.routineRequest.operation;
      card.routineRequest = {
        ...card.routineRequest,
        operation: operation.action === "create"
          ? {
              ...operation,
              routine: {
                ...operation.routine,
                name: redactSecretsInText(operation.routine.name),
                instructions: redactSecretsInText(operation.routine.instructions),
              },
            }
          : operation.action === "update"
            ? {
                ...operation,
                changes: {
                  ...operation.changes,
                  ...(typeof operation.changes.name === "string"
                    ? { name: redactSecretsInText(operation.changes.name) }
                    : {}),
                  ...(typeof operation.changes.instructions === "string"
                    ? { instructions: redactSecretsInText(operation.changes.instructions) }
                    : {}),
                },
              }
            : { ...operation },
      };
    }
    if (card.skillRequest) {
      const originalPreview = card.skillRequest.preview;
      const preview = originalPreview === undefined
        ? undefined
        : redactSecretsInText(originalPreview);
      const previewSha256 = preview !== undefined && preview === originalPreview
        ? createHash("sha256").update(preview).digest("hex")
        : undefined;
      const sha256 = card.skillRequest.sha256 !== undefined
        && card.skillRequest.sha256 === previewSha256
        ? card.skillRequest.sha256
        : undefined;
      card.skillRequest = {
        ...card.skillRequest,
        gist: redactSecretsInText(card.skillRequest.gist),
        source: card.skillRequest.source === undefined
          ? undefined
          : redactSecretsInText(card.skillRequest.source),
        preview,
        sha256,
        warnings: card.skillRequest.warnings.map((warning) => redactSecretsInText(warning)),
      };
    }
    if (card.profileRequest) {
      const scrubChanges = (changes: ProfileRequestChanges): ProfileRequestChanges => {
        const out = { ...changes };
        for (const [key, value] of Object.entries(changes)) {
          if (typeof value === "string") (out as Record<string, string | boolean>)[key] = redactSecretsInText(value);
        }
        return out;
      };
      card.profileRequest = {
        ...card.profileRequest,
        targetName: redactSecretsInText(card.profileRequest.targetName),
        reason: redactSecretsInText(card.profileRequest.reason),
        before: scrubChanges(card.profileRequest.before),
        changes: scrubChanges(card.profileRequest.changes),
      };
    }
    out.card = card;
  }
  if (out.connector) {
    out.connector = {
      ...out.connector,
      label: redactSecretsInText(out.connector.label),
      description: redactSecretsInText(out.connector.description),
      error: out.connector.error ? redactSecretsInText(out.connector.error) : undefined,
    };
  }
  if (out.secret) {
    out.secret = {
      ...out.secret,
      label: redactSecretsInText(out.secret.label),
      description: redactSecretsInText(out.secret.description),
      error: out.secret.error ? redactSecretsInText(out.secret.error) : undefined,
    };
  }
  return out;
}

export const ACTIVITY_BUSY: ReadonlySet<BotActivity> = new Set(["working", "waiting-on-you", "no-signal"]);

export type StoreChange =
  | { type: "sections" }
  | { type: "message"; threadId: string; message: Message }
  | { type: "message.patch"; threadId: string; message: Message }
  | { type: "thread"; threadId: string; activeLeafId: string }
  | { type: "thread.deleted"; threadId: string }
  | { type: "bot"; botId: string }
  | { type: "bot.deleted"; botId: string }
  | { type: "group"; groupId: string }
  | { type: "group.deleted"; groupId: string };

export const UNTITLED_TASK = "New task";
export const UNTITLED_THREAD = "New thread";

const TASK_TITLE_MAX = 80;
export function threadTitleFrom(title?: string): string {
  return title?.trim().slice(0, TASK_TITLE_MAX) || UNTITLED_THREAD;
}

export function titleFromMessage(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line || UNTITLED_TASK;
}

export function titleFromLlm(raw: string): string | null {
  const line = raw
    .trim()
    .split("\n")[0]!
    .replace(/^[#*\-\u2022]+/, "")
    .replace(/^["'\u201C\u201D\u2018\u2019\u0060]+/, "")
    .replace(/["'\u201C\u201D\u2018\u2019\u0060]+$/, "")
    .replace(/^[#*\-\u2022]+/, "")
    .replace(/[#*]+$/, "")
    .replace(/[.\u3002]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length >= 1 && line.length <= 48 ? line : null;
}

export interface BotRecord extends Omit<WireBot, "avatarUrl" | "tasks"> {
  tasks?: TaskRecord[];
  avatarUrl?: string;
  resumeCursors: Record<string, unknown>;
  approvalGrant?: {
    requestId: string;
    mode: "full" | "custom";
    phase: "prepared" | "confirmed" | "activated" | "committed";
    threadId?: string;
    threadOnly?: true;
    refreshPermissions?: true;
    allThreads?: true;
  };
  lastProfileRequestId?: string;
  packageBase?: Partial<Record<AgentPart, PartPair>>;
  assignedSkills?: string[];
}

export type BotWirePrivateKeys = "resumeCursors" | "tasks" | "avatarUrl" | "approvalGrant" | "lastProfileRequestId" | "packageBase" | "assignedSkills";
export type BotWireProjection = Pick<BotRecord, Exclude<keyof BotRecord, BotWirePrivateKeys>>;
export type BotWireProjectionIsExact = AssertExact<Omit<WireBot, "avatarUrl" | "tasks">, BotWireProjection> & AssertSameKeys<Omit<WireBot, "avatarUrl" | "tasks">, BotWireProjection>;
export const botWireProjectionIsExact: BotWireProjectionIsExact = true;

export const CONNECTOR_SLUGS_MAX = 64;
export const CONNECTOR_TOOLS_PER_SERVICE_MAX = 500;

export function parseConnectorTools(value: unknown): { ok: true; grants: Record<string, ConnectorToolGrant> } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "connectorTools must be an object of service slugs to tool grants" };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > CONNECTOR_SLUGS_MAX) {
    return { ok: false, error: `connectorTools may name at most ${CONNECTOR_SLUGS_MAX} services` };
  }
  const grants: Record<string, ConnectorToolGrant> = {};
  for (const [slug, grant] of entries) {
    if (!CONNECTOR_SLUG_PATTERN.test(slug)) {
      return { ok: false, error: `connectorTools service slugs must be lowercase slugs (got "${slug}")` };
    }
    if (!grant || typeof grant !== "object" || Array.isArray(grant)) {
      return { ok: false, error: `connectorTools.${slug} must be a grant like { tools: "*" } or { tools: ["TOOL_NAME"] }` };
    }
    const keys = Object.keys(grant);
    if (keys.length !== 1 || keys[0] !== "tools") {
      return { ok: false, error: `connectorTools.${slug} accepts only a tools field` };
    }
    const tools = (grant as { tools: unknown }).tools;
    if (tools === "*") {
      grants[slug] = { tools: "*" };
      continue;
    }
    if (!Array.isArray(tools) || tools.length === 0) {
      return { ok: false, error: `connectorTools.${slug}.tools must be "*" or a non-empty list of tool names (use {} to grant no tools)` };
    }
    if (tools.length > CONNECTOR_TOOLS_PER_SERVICE_MAX) {
      return { ok: false, error: `connectorTools.${slug}.tools may list at most ${CONNECTOR_TOOLS_PER_SERVICE_MAX} tools` };
    }
    const names: string[] = [];
    for (const tool of tools) {
      if (typeof tool !== "string" || !CONNECTOR_TOOL_NAME_PATTERN.test(tool)) {
        return { ok: false, error: `connectorTools.${slug}.tools names must be Composio tool names like GMAIL_SEND_EMAIL` };
      }
      if (!names.includes(tool)) names.push(tool);
    }
    grants[slug] = { tools: names };
  }
  return { ok: true, grants };
}

function recordList<T>(raw: unknown): T[] | undefined {
  return Array.isArray(raw) && raw.every((item) => item !== null && typeof item === "object" && !Array.isArray(item)) ? raw as T[] : undefined;
}

const BOTS_FILE = join(DATA_DIR, "bots.json");
const GROUPS_FILE = join(DATA_DIR, "groups.json");
const THREAD_MODEL_COPIES_CLEARED = join(DATA_DIR, "thread-model-copies-cleared");
const MAIN_TASK_MODELS_MOVED = join(DATA_DIR, "main-task-models-moved");

function tightenRegistryFile(file: string): void {
  if (process.platform === "win32") return;
  try {
    if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  } catch {}
}
const messagesFile = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);

const COLORS: DogColor[] = [
  "yellow",
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "teal",
  "coral",
];

export const sectionKey = (section?: string | null): string => section?.trim() || "";

export function mentionedBots<T extends { name: string; hidden?: boolean }>(text: string, peers: T[]): T[] {
  const candidates = peers
    .filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  const found: T[] = [];
  let at = -1;
  while ((at = lower.indexOf("@", at + 1)) !== -1) {
    if (!isMentionBoundary(text, at)) continue;
    const rest = lower.slice(at + 1);
    const hit = candidates.find((p) => {
      const name = p.name.toLowerCase();
      if (!rest.startsWith(name)) return false;
      const after = rest.slice(name.length);
      return !isMentionNameContinuation(after);
    });
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}

export function normalizeGroupDefaultResponder(
  value: unknown,
  memberIds: string[],
  dm = false,
): GroupDefaultResponder {
  if (dm) return { kind: "mentions" };
  if (value && typeof value === "object") {
    const candidate = value as { kind?: unknown; botId?: unknown; fallbackBotId?: unknown };
    if (candidate.kind === "everyone") return { kind: "everyone" };
    if (candidate.kind === "mentions") return { kind: "mentions" };
    if (candidate.kind === "auto") {
      return typeof candidate.fallbackBotId === "string" && memberIds.includes(candidate.fallbackBotId)
        ? { kind: "auto", fallbackBotId: candidate.fallbackBotId }
        : { kind: "auto" };
    }
    if (
      candidate.kind === "member" &&
      typeof candidate.botId === "string" &&
      memberIds.includes(candidate.botId)
    ) {
      return { kind: "member", botId: candidate.botId };
    }
  }
  if (memberIds.length === 0) return { kind: "mentions" };
  return { kind: "member", botId: memberIds[0] };
}

export function roomResponders<T extends { id: string; name: string; hidden?: boolean }>(
  text: string,
  members: T[],
  defaultResponder: GroupDefaultResponder,
): T[] {
  const available = members.filter((member) => !member.hidden);
  const everyone = "everyone";
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    const candidate = text.slice(at + 1, at + 1 + everyone.length);
    if (
      isMentionBoundary(text, at) &&
      candidate.toLocaleLowerCase() === everyone &&
      !isMentionNameContinuation(text.slice(at + 1 + everyone.length))
    ) {
      return available;
    }
  }
  const mentioned = mentionedBots(text, available);
  if (mentioned.length) return mentioned;
  if (defaultResponder.kind === "everyone") return available;
  if (defaultResponder.kind === "member") {
    const lead = available.find((member) => member.id === defaultResponder.botId);
    return lead ? [lead] : [];
  }
  if (defaultResponder.kind === "auto") {
    const fallback = available.find((member) => member.id === defaultResponder.fallbackBotId) ?? available[0];
    return fallback ? [fallback] : [];
  }
  return [];
}

function taskCountsAsBotUnread(task: { unread?: boolean; routineRunId?: string }): boolean {
  return Boolean(task.unread) && !task.routineRunId;
}

interface ThreadState {
  messages: Message[];
  activeLeafId: string | null;
}

export class Store {
  bots: BotRecord[] = [];
  groups: GroupRecord[] = [];
  private threads = new Map<string, ThreadState>();
  private defaultSelection: () => ModelSelection;
  private completeNewBotSelection: (selection: ModelSelection) => ModelSelection;
  private driverKindOf: (instanceId: string) => string | undefined;
  private newDogComputer: () => BotRecord["computer"];
  private listeners = new Set<(change: StoreChange) => void>();
  private registeringInitialSections = true;
  private legacyActivities = new Map<string, BotActivity>();
  private mainId: string | null = null;
  readonly damaged: DamagedData[] = [];

  constructor(
    defaultSelection: () => ModelSelection,
    completeNewBotSelection: (selection: ModelSelection) => ModelSelection = (selection) => selection,
    driverKindOf: (instanceId: string) => string | undefined = () => undefined,
    newDogComputer: () => BotRecord["computer"] = () => undefined,
  ) {
    this.defaultSelection = defaultSelection;
    this.completeNewBotSelection = completeNewBotSelection;
    this.driverKindOf = driverKindOf;
    this.newDogComputer = newDogComputer;
    mkdirSync(DATA_DIR, { recursive: true });
    for (const file of [BOTS_FILE, GROUPS_FILE]) tightenRegistryFile(file);
    const bots = readOwnedJson(BOTS_FILE, recordList<BotRecord>);
    const groups = readOwnedJson(GROUPS_FILE, recordList<GroupRecord>);
    const botsLoaded = bots.state === "ok";
    this.bots = bots.state === "ok" ? bots.value : [];
    this.groups = groups.state === "ok" ? groups.value : [];
    if (bots.state === "damaged") this.damaged.push({ name: "bots", keptAs: bots.keptAs });
    if (groups.state === "damaged") this.damaged.push({ name: "groups", keptAs: groups.keptAs });
    this.rememberSections([...this.bots, ...this.groups].map((record) => record.section));
    let botsMigrated = false;
    const browserProfileAliases = loadBrowserProfileIdAliases();
    let groupsMigrated = false;
    for (const b of this.bots) {
      if (b.busy || (b.activity !== undefined && b.activity !== "idle")) botsMigrated = true;
      b.busy = false;
      b.activity = "idle";
      if (typeof b.soul !== "string") {
        b.soul = "";
        botsMigrated = true;
      }
      if (b.soulHash !== soulHash(b.soul)) {
        b.soulHash = soulHash(b.soul);
        botsMigrated = true;
      }
      if (!existsSync(soulFile(b.id))) {
        try { writeSoulMirror(b.id, b.soul); } catch (e) {
          console.warn(`[bot-folder] could not create SOUL.md for ${b.id}: ${(e as Error).message}`);
        }
      }
      if (b.browserProfile) {
        const browserProfile = browserProfileAliases.get(b.browserProfile);
        if (browserProfile && browserProfile !== b.browserProfile) {
          b.browserProfile = browserProfile;
          botsMigrated = true;
        }
      }
      if (b.cloudBackend !== undefined && b.cloudBackend !== "box" && b.cloudBackend !== "vps") {
        delete b.cloudBackend;
        botsMigrated = true;
      }
      if (retirePlaces(b)) botsMigrated = true;
      if (b.autoStartVps !== undefined && b.autoStartVps !== true && b.autoStartVps !== false) {
        delete b.autoStartVps;
        botsMigrated = true;
      }
      if (b.approvalMode !== undefined && !isApprovalMode(b.approvalMode)) {
        delete b.approvalMode;
        botsMigrated = true;
      }
      const retiredTrust = b as { outbound?: unknown; connectorScopes?: unknown };
      if (retiredTrust.outbound !== undefined || retiredTrust.connectorScopes !== undefined) {
        delete retiredTrust.outbound;
        delete retiredTrust.connectorScopes;
        botsMigrated = true;
      }
      if (b.approvalGrant !== undefined) {
        const threadOnly = b.approvalGrant.threadOnly === true;
        if (threadOnly) {
          const target = b.tasks?.find(task => task.threadId === b.approvalGrant?.threadId);
          if (target) { target.approvalMode = "ask"; target.autoApprove = false; }
        }
        if (!threadOnly) {
        b.approvalMode = "ask";
        b.autoApprove = false;
        for (const task of b.tasks ?? []) {
          if (task.approvalMode === "full" || task.approvalMode === "custom") {
            task.approvalMode = "ask";
            task.autoApprove = false;
          }
        }
        }
        delete b.approvalGrant;
        botsMigrated = true;
      }
      const avatar = botAvatarProfile(b);
      if (b.avatarUrl !== undefined && avatar.avatarUrl !== b.avatarUrl) {
        delete b.avatarUrl;
        botsMigrated = true;
      }
      if (b.avatarCrop !== undefined && avatar.avatarCrop !== b.avatarCrop) {
        delete b.avatarCrop;
        botsMigrated = true;
      }
      if (b.avatarZoom !== undefined) {
        const zoom = clampAvatarZoom(b.avatarZoom);
        if (zoom === AVATAR_ZOOM_MIN) {
          delete b.avatarZoom;
          botsMigrated = true;
        } else if (b.avatarZoom !== zoom) {
          b.avatarZoom = zoom;
          botsMigrated = true;
        }
      }
      for (const key of ["avatarFocusX", "avatarFocusY"] as const) {
        if (b[key] === undefined) continue;
        const focus = clampAvatarFocus(b[key]);
        if (focus === AVATAR_FOCUS_CENTER) {
          delete b[key];
          botsMigrated = true;
        } else if (b[key] !== focus) {
          b[key] = focus;
          botsMigrated = true;
        }
      }
    }
    if (this.settleMainDog().length) botsMigrated = true;
    for (const b of this.bots) {
      if (!b.alwaysAllow?.length) continue;
      let changed = false;
      const migrated = b.alwaysAllow.map((key) => {
        const match = key.match(/^(ask_bot|delegate_bot):@(.+)$/);
        if (!match) return key;
        const candidates = this.bots.filter((candidate) => candidate.name === match[2]);
        if (candidates.length !== 1) return key;
        changed = true;
        return peerAllowKey(match[1] as PeerAction, candidates[0]!.id);
      });
      if (changed) {
        b.alwaysAllow = [...new Set(migrated)];
        botsMigrated = true;
      }
    }
    const botIds = new Set(this.bots.map((b) => b.id));
    for (const g of this.groups) {
      g.busyBotId = null;
      delete g.turnStartedAt;
      if (botsLoaded && !g.dm && g.memberIds.some((id) => !botIds.has(id))) {
        g.memberIds = g.memberIds.filter((id) => botIds.has(id));
        groupsMigrated = true;
      }
      const normalized = normalizeGroupDefaultResponder(g.defaultResponder, g.memberIds, Boolean(g.dm));
      if (JSON.stringify(normalized) !== JSON.stringify(g.defaultResponder)) groupsMigrated = true;
      g.defaultResponder = normalized;
      if (g.dm) {
        if (g.tasks !== undefined) {
          delete g.tasks;
          groupsMigrated = true;
        }
        continue;
      }
      if (!g.tasks?.length) {
        const initialTask: GroupTaskRecord = {
          threadId: g.threadId,
          title: this.firstUserLine(g.threadId) ?? UNTITLED_TASK,
          createdAt: g.createdAt,
          updatedAt: g.createdAt,
        };
        if (g.pinnedCwd !== undefined) initialTask.pinnedCwd = g.pinnedCwd;
        if (g.pinnedMessageId) initialTask.pinnedMessageId = g.pinnedMessageId;
        g.tasks = [initialTask];
        groupsMigrated = true;
      }
      let active = g.tasks.find((task) => task.threadId === g.threadId);
      if (!active) {
        active = g.tasks[0]!;
        g.threadId = active.threadId;
        groupsMigrated = true;
      }
      g.pinnedCwd = active.pinnedCwd;
      g.pinnedMessageId = active.pinnedMessageId;
    }
    if (groupsMigrated) this.saveGroups();
    const clearModelCopies = !existsSync(THREAD_MODEL_COPIES_CLEARED) && (botsLoaded || !existsSync(BOTS_FILE));
    const moveMainTaskModels = !existsSync(MAIN_TASK_MODELS_MOVED) && (botsLoaded || !existsSync(BOTS_FILE));
    for (const b of this.bots) {
      if (b.projects?.some((project) => "modelSelection" in project)) {
        b.projects = b.projects.map(({ id, name, emoji }) => ({ id, name, ...(isProjectEmoji(emoji) ? { emoji } : {}) }));
        botsMigrated = true;
      }
      if (!b.tasks?.length) {
        b.tasks = [{
          threadId: b.threadId,
          title: this.firstUserLine(b.threadId) ?? UNTITLED_TASK,
          createdAt: b.createdAt,
          updatedAt: b.createdAt,
          resumeCursors: b.resumeCursors ?? {},
        }];
        botsMigrated = true;
      }
      let active = b.tasks.find((task) => task.threadId === b.threadId);
      if (!active) {
        active = {
          threadId: b.threadId,
          title: this.firstUserLine(b.threadId) ?? UNTITLED_TASK,
          createdAt: b.createdAt,
          updatedAt: b.createdAt,
          resumeCursors: b.resumeCursors ?? {},
        };
        b.tasks.unshift(active);
        botsMigrated = true;
      }
      if (moveMainTaskModels && active.modelSelection !== undefined) {
        if (!sameModelSelection(active.modelSelection, b.modelSelection)) {
          for (const task of b.tasks) {
            if (task !== active && task.modelSelection === undefined) task.modelSelection = structuredClone(b.modelSelection);
          }
        }
        b.modelSelection = active.modelSelection;
        delete active.modelSelection;
        botsMigrated = true;
      }
      for (const task of b.tasks) {
        if (clearModelCopies && task.modelSelection !== undefined && sameModelSelection(task.modelSelection, b.modelSelection)) {
          delete task.modelSelection;
          botsMigrated = true;
        }
        if (!task.resumeCursors) {
          task.resumeCursors = task === active ? (b.resumeCursors ?? {}) : {};
          botsMigrated = true;
        }
        if (task.unread === undefined) {
          task.unread = task === active && b.unread;
          botsMigrated = true;
        }
        if (task.routineRunId && task.unread) {
          task.unread = false;
          botsMigrated = true;
        }
        if (task === active) {
          if (task.rewound === undefined && b.rewound !== undefined) {
            task.rewound = b.rewound;
            botsMigrated = true;
          }
          if (task.pinnedMessageId === undefined && b.pinnedMessageId !== undefined) {
            task.pinnedMessageId = b.pinnedMessageId;
            botsMigrated = true;
          }
        }
        if (task.approvalMode !== undefined && !isApprovalMode(task.approvalMode)) {
          delete task.approvalMode;
          botsMigrated = true;
        }
        if (task.busy !== undefined || task.activity !== undefined || task.turnStartedAt !== undefined || task.workingStartedAt !== undefined) botsMigrated = true;
        task.busy = false;
        task.activity = "idle";
        task.turnStartedAt = undefined;
        task.workingStartedAt = undefined;
      }
      this.mirrorActiveTask(b, active);
      b.unread = b.tasks.some(taskCountsAsBotUnread);
    }
    if (botsMigrated) this.saveBots();
    if (clearModelCopies) writeFileAtomic(THREAD_MODEL_COPIES_CLEARED, "Threads follow their bot's model; the copies older builds made are cleared.\n", { mode: 0o600 });
    if (moveMainTaskModels) writeFileAtomic(MAIN_TASK_MODELS_MOVED, "Each dog's main conversation follows the dog's own model.\n", { mode: 0o600 });
    const knownThreads = new Set([
      ...this.bots.flatMap((b) => [b.threadId, ...(b.tasks ?? []).map((task) => task.threadId)]),
      ...this.groups.flatMap((group) => [group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]),
    ]);
    for (const threadId of knownThreads) {
      const legacyFile = messagesFile(threadId);
      if (existsSync(legacyFile)) mdb.readThread(threadId, legacyFile);
    }
    this.repairThreadUpdatedAts();
    this.repairDuplicatePairConversations();
    this.registeringInitialSections = false;
  }

  private noteThreadActivity(threadId: string, at: number): void {
    if (!Number.isFinite(at)) return;
    const advance = (current: number | undefined) => Math.max(current ?? 0, at);
    for (const bot of this.bots) {
      const task = bot.tasks?.find((candidate) => candidate.threadId === threadId);
      if (!task) continue;
      const next = advance(task.updatedAt);
      if (task.updatedAt !== next) task.updatedAt = next;
    }
    for (const group of this.groups) {
      const task = group.tasks?.find((candidate) => candidate.threadId === threadId);
      if (!task) continue;
      const next = advance(task.updatedAt);
      if (task.updatedAt !== next) task.updatedAt = next;
    }
  }

  private repairThreadUpdatedAts(): void {
    const botTasks = this.bots.flatMap((bot) => bot.tasks ?? []);
    const groupTasks = this.groups.flatMap((group) => group.tasks ?? []);
    const latest = mdb.latestMessageAts([...botTasks, ...groupTasks].map((task) => task.threadId));
    let botsDirty = false;
    let groupsDirty = false;
    const repair = (task: { threadId: string; createdAt: number; updatedAt?: number }) => {
      const fromMessages = latest.get(task.threadId);
      const next = fromMessages !== undefined && (task.updatedAt === undefined || fromMessages > task.updatedAt)
        ? fromMessages
        : task.updatedAt ?? task.createdAt;
      if (task.updatedAt === next) return false;
      task.updatedAt = next;
      return true;
    };
    for (const task of botTasks) if (repair(task)) botsDirty = true;
    for (const task of groupTasks) if (repair(task)) groupsDirty = true;
    if (botsDirty) this.saveBots();
    if (groupsDirty) this.saveGroups();
  }

  private openerIdentity(openedBy: TaskOpenedBy): string {
    if (this.bot(openedBy.botId)) return openedBy.botId;
    const named = this.bots.filter((bot) => bot.name === openedBy.name);
    return named.length === 1 ? named[0].id : openedBy.botId;
  }

  private repairDuplicatePairConversations(): void {
    let botsDirty = false;
    type SweepTask = { openedBy?: TaskOpenedBy; closedBy?: TaskClosedBy };
    const sweep = (tasks: SweepTask[] | undefined, repaired: () => void) => {
      const pairs = new Map<string, SweepTask[]>();
      for (const task of tasks ?? []) {
        const by = task.openedBy;
        if (by?.kind !== "pair" || task.closedBy) continue;
        const identity = this.openerIdentity(by);
        pairs.set(identity, [...(pairs.get(identity) ?? []), task]);
      }
      for (const rows of pairs.values()) {
        for (const duplicate of rows.slice(1)) {
          const by = duplicate.openedBy!;
          const identity = this.openerIdentity(by);
          const { kind: _kind, ...opened } = by;
          duplicate.openedBy = opened;
          duplicate.closedBy = {
            botId: identity,
            name: this.bot(identity)?.name ?? by.name,
            at: Date.now(),
          };
          repaired();
        }
      }
    };
    for (const bot of this.bots) sweep(bot.tasks, () => { botsDirty = true; });
    if (botsDirty) this.saveBots();
  }

  private saveBots(bots: BotRecord[] = this.bots, registerSections = true) {
    if (registerSections) this.rememberSections([...this.bots, ...bots].map((bot) => bot.section));
    writeFileAtomicIfChanged(BOTS_FILE, JSON.stringify(bots.map(({ busy: _busy, activity: _activity, ...bot }) => ({
      ...bot,
      tasks: bot.tasks?.map(({ busy: _taskBusy, activity: _taskActivity, turnStartedAt: _taskTurnStarted, workingStartedAt: _taskWorkingStarted, ...task }) => persistedPin(task)),
    })), null, 2), { mode: 0o600 });
  }

  private saveGroups(groups: GroupRecord[] = this.groups, registerSections = true) {
    if (registerSections) this.rememberSections(groups.map((group) => group.section));
    writeFileAtomicIfChanged(GROUPS_FILE, JSON.stringify(groups.map(({ busyBotId: _busyBotId, turnStartedAt: _turnStartedAt, ...g }) => ({
      ...g,
      ...(g.tasks ? { tasks: g.tasks.map((task) => persistedPin(task)) } : {}),
    })), null, 2), { mode: 0o600 });
  }

  get sections(): string[] { return readSections(); }

  private rememberSections(names: (string | undefined)[]) {
    try {
      if (ensureSections(names)) this.emit({ type: "sections" });
    } catch (error) {
      if (!this.registeringInitialSections) throw error;
      console.warn(`[teams] Startup could not register team names; saved teams and shared instructions were left unchanged: ${(error as Error).message}`);
    }
  }

  renameSection(name: string, nextName: string, computers?: TeamComputers): string | undefined {
    if (!name || !this.sections.includes(name)) return "No such section";
    nextName = nextName.trim();
    if (!nextName || nextName.length > 60 || [...nextName].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return "Section name must be 1 to 60 characters without control characters";
    if (name === nextName) return undefined;
    if (this.sections.includes(nextName) || computers?.forSection(nextName)) return "A section with that name already exists";
    const members = this.bots.filter(bot => sectionKey(bot.section) === name);
    const rooms = this.groups.filter(group => sectionKey(group.section) === name);
    const affected = members;
    if (affected.some(bot => bot.busy || bot.tasks?.some(task => task.busy)) || rooms.some(group => group.busyBotId)) {
      return "Stop the work in this section before renaming it";
    }
    if (!members.length && !rooms.length && !computers?.forSection(name)) return this.changeEmptySection(name, nextName);
    const nextBots = this.bots.map(bot => members.includes(bot) ? { ...bot, section: nextName } : bot);
    const nextGroups = this.groups.map(group => rooms.includes(group) ? { ...group, section: nextName } : group);
    let computerChanged = false;
    try {
      this.saveBots(nextBots, false);
      this.saveGroups(nextGroups, false);
      computerChanged = computers?.renameSection(name, nextName) ?? false;
      changeEmptySection(name, nextName);
    } catch (error) {
      this.saveBots(this.bots, false);
      this.saveGroups(this.groups, false);
      if (computerChanged) computers!.renameSection(nextName, name);
      throw error;
    }
    for (let i = 0; i < nextBots.length; i++) Object.assign(this.bots[i], nextBots[i]);
    for (let i = 0; i < nextGroups.length; i++) Object.assign(this.groups[i], nextGroups[i]);
    for (const bot of affected) this.emit({ type: "bot", botId: bot.id });
    for (const room of rooms) this.emit({ type: "group", groupId: room.id });
    this.emit({ type: "sections" });
    return undefined;
  }

  orderSections(order: readonly string[]): string[] {
    if (orderSections(order)) this.emit({ type: "sections" });
    return this.sections;
  }

  changeEmptySection(name: string, nextName: string | null): string | undefined {
    if (!this.sections.includes(name)) return "No such section";
    if ([...this.bots, ...this.groups].some((record) => sectionKey(record.section) === name)) {
      return "Move all dogs (including archived dogs) and group chats out of this section first";
    }
    if (nextName !== null && nextName !== name && this.sections.includes(nextName)) {
      return "A section with that name already exists";
    }
    if (nextName === name) return undefined;
    changeEmptySection(name, nextName);
    this.emit({ type: "sections" });
    return undefined;
  }

  deleteSection(name: string): string | undefined {
    if (!name || !this.sections.includes(name)) return "No such section";
    const members = this.bots.filter(bot => sectionKey(bot.section) === name);
    const rooms = this.groups.filter(group => sectionKey(group.section) === name);
    if (members.some(bot => bot.busy || bot.tasks?.some(task => task.busy)) || rooms.some(group => group.busyBotId)) {
      return "Stop the work in this section before deleting it";
    }
    const nextBots = this.bots.map(bot => sectionKey(bot.section) === name ? { ...bot, section: undefined } : bot);
    const nextGroups = this.groups.map(group => sectionKey(group.section) === name ? { ...group, section: undefined } : group);
    try {
      this.saveBots(nextBots);
      this.saveGroups(nextGroups);
      changeEmptySection(name, null);
    } catch (error) {
      this.saveBots();
      this.saveGroups();
      throw error;
    }
    for (let i = 0; i < nextBots.length; i++) Object.assign(this.bots[i], nextBots[i]);
    for (let i = 0; i < nextGroups.length; i++) Object.assign(this.groups[i], nextGroups[i]);
    for (const bot of this.bots) this.emit({ type: "bot", botId: bot.id });
    for (const group of rooms) this.emit({ type: "group", groupId: group.id });
    this.emit({ type: "sections" });
    return undefined;
  }

  onChange(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: StoreChange) {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(change);
      } catch (error) {
        console.error("store: change listener threw", error);
      }
    }
  }

  group(id: string): GroupRecord | undefined {
    return this.groups.find((g) => g.id === id);
  }

  groupByThread(threadId: string): GroupRecord | undefined {
    return this.groups.find(
      (group) => group.threadId === threadId || group.tasks?.some((task) => task.threadId === threadId),
    );
  }

  createGroup(
    name: string,
    memberIds: string[],
    dm = false,
    section?: string,
    setup?: {
      bulletin?: string;
      defaultResponder?: GroupDefaultResponder;
      completed?: boolean;
    },
  ): GroupRecord {
    this.rememberSections([section]);
    const threadId = newId();
    const createdAt = Date.now();
    const group: GroupRecord = {
      id: newId(),
      threadId,
      name,
      memberIds,
      defaultResponder: dm
        ? { kind: "mentions" }
        : normalizeGroupDefaultResponder(setup?.defaultResponder, memberIds, false),
      bulletin: setup?.bulletin ?? "",
      unread: false,
      createdAt,
      dm: dm || undefined,
      busyBotId: null,
      section,
    };
    if (!dm) {
      group.tasks = [{ threadId, title: UNTITLED_TASK, createdAt, updatedAt: createdAt }];
      group.setupCompletedAt = setup?.completed ? createdAt : null;
      group.setupSkippedAt = null;
    }
    this.groups.unshift(group);
    this.saveGroups();
    this.emit({ type: "group", groupId: group.id });
    return group;
  }

  dmGroup(a: string, b: string): GroupRecord | undefined {
    return this.groups.find(
      (g) => g.dm && g.memberIds.length === 2 && g.memberIds.includes(a) && g.memberIds.includes(b),
    );
  }

  patchGroup(id: string, patch: Partial<Pick<GroupRecord, "name" | "memberIds" | "defaultResponder" | "bulletin" | "unread" | "busyBotId" | "cwd" | "pinnedMessageId" | "section" | "setupCompletedAt" | "setupSkippedAt" | "audienceFloor" | "installedPackage" | "turnTimeoutMinutes">>): GroupRecord | null {
    const group = this.group(id);
    if (!group) return null;
    if (Object.prototype.hasOwnProperty.call(patch, "section")) {
      this.rememberSections([patch.section]);
    }
    const previousBusyBotId = group.busyBotId;
    Object.assign(group, patch);
    if (Object.prototype.hasOwnProperty.call(patch, "busyBotId")) {
      if (patch.busyBotId && patch.busyBotId !== previousBusyBotId) group.turnStartedAt = Date.now();
      else if (!patch.busyBotId) delete group.turnStartedAt;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "turnTimeoutMinutes") && patch.turnTimeoutMinutes == null) {
      delete group.turnTimeoutMinutes;
    }
    if (!group.dm && Object.prototype.hasOwnProperty.call(patch, "pinnedMessageId")) {
      const active = this.activeGroupTask(group.id);
      if (active) active.pinnedMessageId = patch.pinnedMessageId;
    }
    group.defaultResponder = normalizeGroupDefaultResponder(
      group.defaultResponder,
      group.memberIds,
      Boolean(group.dm),
    );
    this.saveGroups();
    this.emit({ type: "group", groupId: group.id });
    return group;
  }

  private deleteThreadRecord(threadId: string) {
    this.threads.delete(threadId);
    mdb.deleteThread(threadId);
    for (const file of [
      messagesFile(threadId),
      `${messagesFile(threadId)}.imported`,
      join(EVENTS_DIR, `${threadId}.ndjson`),
      join(NATIVE_DIR, `${threadId}.ndjson`),
    ]) {
      try {
        unlinkSync(file);
      } catch {}
    }
    this.emit({ type: "thread.deleted", threadId });
  }

  deleteGroup(id: string): boolean {
    const group = this.group(id);
    if (!group) return false;
    this.groups = this.groups.filter((g) => g.id !== id);
    this.saveGroups();
    for (const threadId of new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)])) {
      this.deleteThreadRecord(threadId);
    }
    this.emit({ type: "group.deleted", groupId: id });
    return true;
  }

  groupTasks(groupId: string): GroupTaskRecord[] {
    const group = this.group(groupId);
    return group?.dm ? [] : (group?.tasks ?? []);
  }

  activeGroupTask(groupId: string): GroupTaskRecord | undefined {
    const group = this.group(groupId);
    return group?.tasks?.find((task) => task.threadId === group.threadId);
  }

  groupTaskByThread(groupId: string, threadId: string): GroupTaskRecord | undefined {
    const group = this.group(groupId);
    if (!group || group.dm) return undefined;
    return group.tasks?.find((task) => task.threadId === threadId);
  }

  createGroupTask(groupId: string, title?: string, activate = true): GroupTaskRecord | null {
    const group = this.group(groupId);
    if (!group || group.dm) return null;
    const createdAt = Date.now();
    const task: GroupTaskRecord = {
      threadId: newId(),
      title: title?.trim().slice(0, 80) || UNTITLED_TASK,
      createdAt,
      updatedAt: createdAt,
    };
    group.tasks = [task, ...(group.tasks ?? [])];
    if (activate) {
      group.threadId = task.threadId;
      group.pinnedCwd = undefined;
      group.pinnedMessageId = undefined;
    }
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return task;
  }

  switchGroupTask(groupId: string, threadId: string): GroupRecord | null {
    const group = this.group(groupId);
    const task = group?.tasks?.find((candidate) => candidate.threadId === threadId);
    if (!group || group.dm || !task) return null;
    group.threadId = task.threadId;
    group.pinnedCwd = task.pinnedCwd;
    group.pinnedMessageId = task.pinnedMessageId;
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return group;
  }

  setGroupTaskPinned(groupId: string, threadId: string, pinned: boolean): GroupTaskRecord | null {
    const task = this.groupTaskByThread(groupId, threadId);
    if (!task) return null;
    if (pinned) task.pinned = true;
    else delete task.pinned;
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return task;
  }

  setGroupTaskTurnTimeout(groupId: string, threadId: string, minutes: number | null): GroupTaskRecord | null {
    const task = this.groupTaskByThread(groupId, threadId);
    if (!task) return null;
    if (minutes == null) delete task.turnTimeoutMinutes;
    else task.turnTimeoutMinutes = minutes;
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return task;
  }

  renameGroupTask(groupId: string, threadId: string, title: string): GroupTaskRecord | null {
    const task = this.groupTaskByThread(groupId, threadId);
    if (!task) return null;
    task.title = title.trim().slice(0, 80) || UNTITLED_TASK;
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return task;
  }

  titleGroupTaskFromFirstMessage(groupId: string, text: string, threadId?: string): GroupTaskRecord | null {
    const task = threadId ? this.groupTaskByThread(groupId, threadId) : this.activeGroupTask(groupId);
    if (!task || task.titleFromFirstMessage || task.title !== UNTITLED_TASK) return null;
    task.title = titleFromMessage(text);
    task.titleFromFirstMessage = true;
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return task;
  }

  retitleGroupTask(groupId: string, threadId: string, machineTitle: string, title: string): GroupTaskRecord | null {
    const task = this.groupTaskByThread(groupId, threadId);
    if (!task || task.title !== machineTitle) return null;
    return this.renameGroupTask(groupId, threadId, threadTitleFrom(title));
  }

  deleteGroupTask(groupId: string, threadId: string): GroupRecord | null {
    const group = this.group(groupId);
    if (!group || group.dm || !group.tasks || group.tasks.length < 2) return null;
    if (!group.tasks.some((task) => task.threadId === threadId)) return null;
    group.tasks = group.tasks.filter((task) => task.threadId !== threadId);
    this.deleteThreadRecord(threadId);
    if (group.threadId === threadId) {
      const next = group.tasks[0]!;
      group.threadId = next.threadId;
      group.pinnedCwd = next.pinnedCwd;
      group.pinnedMessageId = next.pinnedMessageId;
    }
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return group;
  }

  toggleReaction(threadId: string, messageId: string, emoji: string, by: string): Message | null {
    const existing = this.messagesFor(threadId).find((m) => m.id === messageId);
    if (!existing) return null;
    const reactions = existing.reactions ?? [];
    const at = reactions.findIndex((r) => r.emoji === emoji && r.by === by);
    const next = at >= 0 ? reactions.filter((_, i) => i !== at) : [...reactions, { emoji, by }];
    return this.patchMessage(threadId, messageId, { reactions: next.length ? next : undefined });
  }

  private thread(threadId: string): ThreadState {
    const t = this.threads.get(threadId);
    if (t) return t;
    return this.cacheThread(threadId, mdb.readThread(threadId, messagesFile(threadId)));
  }

  private cacheThread(threadId: string, rows: mdb.ThreadRows): ThreadState {
    const { messages, activeLeafId: storedLeaf } = rows;
    let activeLeafId = storedLeaf;
    let prev: string | null = null;
    for (const m of messages) {
      if (m.parentId === undefined) m.parentId = prev;
      prev = m.id;
    }
    if (!activeLeafId) activeLeafId = messages.at(-1)?.id ?? null;
    const t = { messages, activeLeafId };
    this.threads.set(threadId, t);
    return t;
  }

  messagesFor(threadId: string): Message[] {
    return this.thread(threadId).messages;
  }

  messagesTail(threadId: string, limit: number): { messages: Message[]; hasMore: boolean; activeLeafId: string | null } {
    let state = this.threads.get(threadId);
    if (!state) {
      const tail = mdb.readThreadTail(threadId, messagesFile(threadId), limit);
      const legacyRows = tail.hasMore !== undefined && tail.messages.some((m) => m.parentId === undefined);
      if (tail.hasMore !== true || legacyRows) {
        state = this.cacheThread(threadId, legacyRows ? mdb.readThread(threadId, messagesFile(threadId)) : tail);
      } else {
        return {
          messages: tail.messages,
          hasMore: tail.hasMore,
          activeLeafId: tail.activeLeafId ?? tail.messages.at(-1)?.id ?? null,
        };
      }
    }
    const { messages, activeLeafId } = state;
    const start = Math.max(0, messages.length - limit);
    return { messages: messages.slice(start), hasMore: start > 0, activeLeafId };
  }

  importTranscript(threadId: string, messages: Message[], activeLeafId: string | null): void {
    if (this.messagesFor(threadId).length) throw new Error("Cannot import over an existing conversation");
    mdb.importThread(threadId, messages, activeLeafId);
    this.threads.delete(threadId);
    const newest = messages.reduce((max, message) => Math.max(max, message.at), Number.NEGATIVE_INFINITY);
    if (Number.isFinite(newest)) this.noteThreadActivity(threadId, newest);
  }

  activeLeaf(threadId: string): string | null {
    return this.thread(threadId).activeLeafId;
  }

  activePath(threadId: string): Message[] {
    const t = this.thread(threadId);
    const byId = new Map(t.messages.map((m) => [m.id, m]));
    const path: Message[] = [];
    let cur = t.activeLeafId ? byId.get(t.activeLeafId) : undefined;
    while (cur) {
      path.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return path.reverse();
  }

  markTerminalAssistantMessage(threadId: string, turnId: string): Message | null {
    const said = this.activePath(threadId).filter((message) =>
      message.role === "bot" && message.kind === "text" && message.turnId === turnId);
    const message = said.findLast((candidate) => candidate.text?.trim()) ?? said.at(-1);
    if (!message) return null;
    if (message.turnTerminal) return message;
    return this.patchMessage(threadId, message.id, { turnTerminal: true });
  }

  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }, command?: Command): Message {
    const t = this.thread(threadId);
    const full: Message = { id: newId(), at: Date.now(), parentId: t.activeLeafId, ...redactBotAuthored(message) };
    const persist = () => { mdb.appendMessage(threadId, full); return full; };
    const committed = command ? runCommand(command, persist) : persist();
    if (committed.id !== full.id) return committed;
    t.messages.push(full);
    t.activeLeafId = full.id;
    if (full.kind === "screen") {
      for (const pruned of this.pruneScreenFrames(t)) {
        mdb.updateMessage(threadId, pruned);
        this.emit({ type: "message.patch", threadId, message: pruned });
      }
    }
    this.noteThreadActivity(threadId, full.at);
    this.emit({ type: "message", threadId, message: full });
    if (full.role === "user" && full.kind === "text") this.dismissOnboardingCard(threadId);
    return full;
  }

  insertMessageAfter(threadId: string, anchorId: string | undefined, message: Omit<Message, "id" | "at">): Message {
    const t = this.thread(threadId);
    const anchorExists = anchorId !== undefined && t.messages.some((m) => m.id === anchorId);
    if (!anchorExists || t.activeLeafId === anchorId) return this.appendMessage(threadId, message);
    const full: Message = { id: newId(), at: Date.now(), ...redactBotAuthored(message), parentId: anchorId };
    const children = t.messages.filter((m) => m.parentId === anchorId);
    t.messages.push(full);
    mdb.insertMessage(threadId, full);
    if (full.kind === "screen") {
      for (const pruned of this.pruneScreenFrames(t)) {
        mdb.updateMessage(threadId, pruned);
        this.emit({ type: "message.patch", threadId, message: pruned });
      }
    }
    this.noteThreadActivity(threadId, full.at);
    this.emit({ type: "message", threadId, message: full });
    for (const child of children) this.patchMessage(threadId, child.id, { parentId: full.id });
    return full;
  }

  dismissOnboardingCard(threadId: string): Message | null {
    const t = this.thread(threadId);
    const card = t.messages.find(
      (message) => message.kind === "options" && message.card && !message.card.requestId && !message.card.dismissed,
    );
    if (!card?.card) return null;
    return this.patchMessage(threadId, card.id, { card: { ...card.card, dismissed: true } });
  }

  private pruneScreenFrames(t: { messages: Message[] }, keep = 4): Message[] {
    const pruned: Message[] = [];
    let seen = 0;
    for (let i = t.messages.length - 1; i >= 0 && seen < t.messages.length; i--) {
      const m = t.messages[i];
      if (m.kind !== "screen" || !m.png) continue;
      seen += 1;
      if (seen > keep) {
        m.png = undefined;
        pruned.push(m);
      }
    }
    return pruned;
  }

  branchMessage(threadId: string, sourceId: string, text: string, sendId?: string, sender?: Message["sender"]): Message | null {
    const t = this.thread(threadId);
    const source = t.messages.find((m) => m.id === sourceId);
    if (!source) return null;
    const full: Message = {
      id: newId(),
      at: Date.now(),
      role: "user",
      kind: "text",
      text,
      parentId: source.parentId ?? null,
      replyToId: source.replyToId,
      ...(sendId ? { sendId } : {}),
      ...(sender ? { sender } : {}),
    };
    t.messages.push(full);
    t.activeLeafId = full.id;
    mdb.appendMessage(threadId, full);
    this.noteThreadActivity(threadId, full.at);
    this.emit({ type: "message", threadId, message: full });
    this.emit({ type: "thread", threadId, activeLeafId: full.id });
    return full;
  }

  setActiveLeaf(threadId: string, messageId: string): string | null {
    const t = this.thread(threadId);
    if (!t.messages.some((m) => m.id === messageId)) return null;
    let cur = messageId;
    for (;;) {
      const children = t.messages.filter((m) => m.parentId === cur);
      if (!children.length) break;
      cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
    }
    t.activeLeafId = cur;
    mdb.setActiveLeaf(threadId, cur);
    this.emit({ type: "thread", threadId, activeLeafId: cur });
    return cur;
  }

  patchMessage(threadId: string, messageId: string, patch: Partial<Message>, command?: Command): Message | null {
    const t = this.thread(threadId);
    const idx = t.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return null;
    const next = { ...t.messages[idx], ...patch, card: patch.card ?? t.messages[idx].card };
    let applied = false;
    const persist = () => { mdb.updateMessage(threadId, next); applied = true; return next; };
    const committed = command ? runCommand(command, persist) : persist();
    if (!applied) return committed;
    t.messages[idx] = next;
    this.emit({ type: "message.patch", threadId, message: next });
    return next;
  }

  bot(id: string) {
    return this.bots.find((b) => b.id === id) ?? null;
  }

  botByThread(threadId: string) {
    return this.bots.find((b) => b.threadId === threadId || b.tasks?.some((t) => t.threadId === threadId)) ?? null;
  }

  private newBotSelection(requested?: ModelSelection): ModelSelection {
    return this.completeNewBotSelection(requested ?? this.defaultSelection());
  }

  createBot(
    profile: Partial<
      Pick<
        BotRecord,
        "name" | "title" | "description" | "soul" | "color" | "mascotExpression" | "mascotBody" | "modelSelection" | "section" | "cwd" | "visibility" | "toolScope"
      >
    > = {},
    opts: {
      seedMessages?: boolean;
    } = {},
  ): BotRecord {
    const toolScope = parseToolScope(profile.toolScope);
    if (!toolScope.ok) throw new Error(toolScope.error);
    this.rememberSections([profile.section]);
    const name = profile.name?.trim() || pickBotName(this.bots.map((b) => b.name));
    const section = sectionKey(profile.section);
    const bot: BotRecord = {
      id: newId(),
      threadId: newId(),
      name,
      title: profile.title ?? "",
      description: profile.description ?? "",
      soul: profile.soul ?? "",
      soulHash: soulHash(profile.soul ?? ""),
      notifications: true,
      color: profile.color ?? COLORS[this.bots.length % COLORS.length],
      ...(profile.mascotExpression ? { mascotExpression: profile.mascotExpression } : {}),
      ...(profile.mascotBody ? { mascotBody: profile.mascotBody } : {}),
      ...(profile.visibility && profile.visibility !== "everyone" ? { visibility: structuredClone(profile.visibility) } : {}),
      ...(toolScope.scope ? { toolScope: toolScope.scope } : {}),
      unread: false,
      modelSelection: this.newBotSelection(profile.modelSelection),
      resumeCursors: {},
      createdAt: Date.now(),
    };
    if (section) bot.section = section;
    if (profile.cwd) bot.cwd = profile.cwd;
    const computer = this.newDogComputer();
    if (computer) bot.computer = computer;
    bot.tasks = [{
      threadId: bot.threadId,
      title: UNTITLED_THREAD,
      createdAt: bot.createdAt,
      updatedAt: bot.createdAt,
      resumeCursors: {},
      unread: false,
      activity: "idle",
      busy: false,
    }];
    this.saveBots([bot, ...this.bots]);
    this.bots.unshift(bot);
    this.saveSettledMainDog(bot.id);
    try {
      writeSoulMirror(bot.id, bot.soul ?? "");
    } catch (e) {
      console.warn(`[bot-folder] could not write SOUL.md mirror for ${bot.id}: ${(e as Error).message}`);
    }
    this.emit({ type: "bot", botId: bot.id });
    if (opts.seedMessages !== false) {
      this.appendMessage(bot.threadId, {
        role: "bot",
        kind: "text",
        text: `Hi, I'm ${name}. What would you like me to do?`,
      });
    }
    return bot;
  }

  private switchNeedsAsk(botId: string, threadId: string, from: ModelSelection, to: ModelSelection): boolean {
    if (from.instanceId === to.instanceId) return false;
    const thread = this.projectBotForTask(botId, threadId);
    return Boolean(thread) && modelSwitchNeedsAsk(approvalModeFor(thread!), this.driverKindOf(from.instanceId), this.driverKindOf(to.instanceId));
  }

  private withDefaultModel(bot: BotRecord, next: ModelSelection): TaskRecord[] | undefined {
    return bot.tasks?.map((task) => ({
      ...task,
      approvalMode: approvalModeFor(this.projectBotForTask(bot.id, task.threadId)!),
      autoApprove: task.autoApprove ?? bot.autoApprove,
      alwaysAllow: structuredClone(task.alwaysAllow ?? bot.alwaysAllow ?? []),
      ...(task.modelSelection === undefined && this.switchNeedsAsk(bot.id, task.threadId, bot.modelSelection, next) ? structuredClone(ASK_NOW) : {}),
    }));
  }

  applyModelDefault(id: string, modelSelection: ModelSelection): BotRecord | null {
    const previous = this.bot(id);
    if (!previous) return null;
    const next: BotRecord = { ...previous, modelSelection: structuredClone(modelSelection), tasks: this.withDefaultModel(previous, modelSelection) };
    this.saveBots(this.bots.map((candidate) => candidate.id === id ? next : candidate));
    this.bots = this.bots.map((candidate) => candidate.id === id ? next : candidate);
    this.emit({ type: "bot", botId: id });
    return next;
  }

  deleteBot(id: string): boolean {
    const bot = this.bot(id);
    if (!bot) return false;
    const nextBots = this.bots.filter((b) => b.id !== id);
    this.saveBots(nextBots);
    this.bots = nextBots;
    this.saveSettledMainDog();
    this.legacyActivities.delete(id);
    const rooms = this.groups.filter((g) => !g.dm && g.memberIds.includes(id));
    for (const g of rooms) {
      g.memberIds = g.memberIds.filter((member) => member !== id);
      if (g.busyBotId === id) { g.busyBotId = null; delete g.turnStartedAt; }
      g.defaultResponder = normalizeGroupDefaultResponder(g.defaultResponder, g.memberIds, false);
    }
    if (rooms.length) {
      try { this.saveGroups(); } catch (error) { console.warn("store: room cleanup will retry on restart", error); }
    }
    for (const threadId of new Set([bot.threadId, ...(bot.tasks ?? []).map((t) => t.threadId)])) {
      this.deleteThreadRecord(threadId);
    }
    try {
      rmSync(workspaceDir(id), { recursive: true, force: true });
    } catch {}
    try {
      rmSync(join(DATA_DIR, "skill-state", id), { recursive: true, force: true });
    } catch {}
    removeBotFolder(id);
    this.emit({ type: "bot.deleted", botId: id });
    for (const g of rooms) this.emit({ type: "group", groupId: g.id });
    return true;
  }

  patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null {
    const bot = this.bot(id);
    if (!bot) return null;
    if (Object.hasOwn(patch, "chiefOfStaff")) {
      patch = { ...patch };
      delete patch.chiefOfStaff;
    }
    if (patch.connectorTools !== undefined) {
      const parsed = parseConnectorTools(patch.connectorTools);
      if (!parsed.ok) throw new Error(parsed.error);
      patch = { ...patch, connectorTools: parsed.grants };
    }
    if (Object.hasOwn(patch, "toolScope")) {
      const parsed = parseToolScope(patch.toolScope);
      if (!parsed.ok) throw new Error(parsed.error);
      patch = { ...patch, toolScope: parsed.scope };
    }
    const wideningToolScope = Object.hasOwn(patch, "toolScope") && toolScopeWidens(bot.toolScope, patch.toolScope);
    const nextToolScope = patch.toolScope;
    if (wideningToolScope) {
      patch = { ...patch };
      delete patch.toolScope;
    }
    const renamedFrom = patch.name !== undefined && patch.name !== bot.name ? bot.name : undefined;
    const former = renamedFrom !== undefined ? formerNamesAfterRename(bot, patch.name!) : undefined;
    if (former) patch = { ...patch, formerNames: former };
    const toAsk = patch.modelSelection ? (bot.tasks ?? []).filter((task) => task.modelSelection === undefined &&
      this.switchNeedsAsk(id, task.threadId, bot.modelSelection, patch.modelSelection!)) : [];
    Object.assign(bot, patch);
    for (const task of toAsk) Object.assign(task, structuredClone(ASK_NOW));
    const task = this.activeTask(id);
    if (task) {
      for (const key of ["resumeCursors", "rewound", "pinnedMessageId", "unread"] as const) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
          Object.assign(task, { [key]: structuredClone(patch[key]) });
        }
      }
      bot.unread = bot.tasks!.some(taskCountsAsBotUnread);
    }
    if (wideningToolScope) {
      this.saveBots(this.bots.map((candidate) => candidate === bot ? { ...bot, toolScope: nextToolScope } : candidate));
      bot.toolScope = nextToolScope;
    } else this.saveBots();
    if (renamedFrom !== undefined) this.refreshExchangeNames(id, renamedFrom);
    this.emit({ type: "bot", botId: id });
    return bot;
  }

  private refreshExchangeNames(botId: string, previousName: string): void {
    let changed = false;
    for (const group of this.groups) {
      if (!group.dm || group.memberIds.length !== 2 || !group.memberIds.includes(botId)) continue;
      const [first, second] = group.memberIds.map((id) => this.bot(id));
      if (!first || !second) continue;
      const wasNamed = (dog: BotRecord) => (dog.id === botId ? previousName : dog.name);
      if (group.name !== exchangeName({ name: wasNamed(first) }, { name: wasNamed(second) })) continue;
      const name = exchangeName(first, second);
      if (group.name === name) continue;
      group.name = name;
      changed = true;
      this.emit({ type: "group", groupId: group.id });
    }
    if (changed) this.saveGroups();
    for (const bot of this.bots) {
      if (bot.id !== botId && bot.tasks?.some((task) => task.openedBy?.botId === botId || task.closedBy?.botId === botId)) {
        this.emit({ type: "bot", botId: bot.id });
      }
    }
  }

  clearVoiceSelections(): BotRecord[] {
    const changed = this.bots.filter((bot) => bot.voice !== undefined && bot.voice !== "");
    if (!changed.length) return [];
    const next = this.bots.map((bot) =>
      bot.voice === undefined || bot.voice === "" ? bot : { ...bot, voice: undefined });
    this.saveBots(next);
    for (const bot of changed) {
      delete bot.voice;
      this.emit({ type: "bot", botId: bot.id });
    }
    return changed;
  }

  patchBotProfile(id: string, patch: BotProfilePatch & Partial<Pick<BotRecord, "cwd" | "lastProfileRequestId">>): BotRecord | null {
    const bot = this.bot(id);
    if (!bot) return null;
    const next = { ...bot, ...patch };
    const renamedFrom = patch.name !== undefined && patch.name !== bot.name ? bot.name : undefined;
    const former = renamedFrom !== undefined ? formerNamesAfterRename(bot, patch.name!) : undefined;
    if (former) next.formerNames = former;
    if (patch.soul !== undefined) {
      next.soulHash = soulHash(patch.soul);
      next.soulDrift = false;
    }
    this.saveBots(this.bots.map((candidate) => candidate.id === id ? next : candidate));
    Object.assign(bot, next);
    if (renamedFrom !== undefined) this.refreshExchangeNames(id, renamedFrom);
    if (patch.soul !== undefined) {
      try { writeSoulMirror(id, patch.soul); } catch (e) {
        console.warn(`[bot-folder] could not write SOUL.md mirror for ${id}: ${(e as Error).message}`);
      }
    }
    this.emit({ type: "bot", botId: id });
    return bot;
  }

  setSoul(id: string, soul: string): BotRecord | null {
    return this.patchBotProfile(id, { soul });
  }

  setBotsSection(
    botIds: string[],
    section: string,
  ): { ok: true; bots: BotRecord[] } | { ok: false; reason: "unavailable" } {
    const ids = [...new Set(botIds)];
    const targets = ids.map((id) => this.bot(id));
    if (targets.some((bot) => !bot || bot.hidden)) return { ok: false, reason: "unavailable" };

    const targetSection = sectionKey(section);
    const selected = targets as BotRecord[];

    const patches = new Map<string, Partial<BotRecord>>();
    for (const bot of selected) {
      patches.set(bot.id, { section: targetSection || undefined });
    }

    const changedIds = new Set<string>();
    const nextBots = this.bots.map((bot) => {
      const patch = patches.get(bot.id);
      if (!patch) return bot;
      const next = { ...bot, ...patch };
      if (JSON.stringify(next) !== JSON.stringify(bot)) changedIds.add(bot.id);
      return next;
    });
    if (changedIds.size) {
      this.saveBots(nextBots);
      for (const bot of this.bots) {
        const patch = patches.get(bot.id);
        if (patch) Object.assign(bot, patch);
      }
      for (const botId of changedIds) this.emit({ type: "bot", botId });
    }
    this.rememberSections([targetSection]);
    return { ok: true, bots: ids.map((id) => this.bot(id)!) };
  }

  updateTeamMembers(section: string, addIds: string[], removeIds: string[]):
    { ok: true; bots: BotRecord[] } | { ok: false; reason: "unavailable" | "membership-changed" } {
    const key = sectionKey(section);
    if (!key || !this.sections.includes(key)) return { ok: false, reason: "unavailable" };
    const adds = new Set(addIds), removes = new Set(removeIds);
    const ids = new Set([...adds, ...removes]);
    for (const id of ids) {
      const bot = this.bot(id);
      if (!bot || bot.hidden) return { ok: false, reason: "unavailable" };
      if (adds.has(id) && removes.has(id)) return { ok: false, reason: "membership-changed" };
      if (removes.has(id) && sectionKey(bot.section) !== key) return { ok: false, reason: "membership-changed" };
    }
    const next = this.bots.map(bot => ids.has(bot.id)
      ? { ...bot, section: adds.has(bot.id) ? key : undefined } : bot);
    if (ids.size) {
      this.saveBots(next);
      for (let i = 0; i < next.length; i++) if (ids.has(next[i].id)) Object.assign(this.bots[i], next[i]);
      for (const botId of ids) this.emit({ type: "bot", botId });
    }
    return { ok: true, bots: this.bots.filter(bot => ids.has(bot.id)) };
  }

  setActivity(botId: string, activity: BotActivity): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    if ((this.legacyActivities.get(botId) ?? "idle") === activity) return bot;
    this.legacyActivities.set(botId, activity);
    this.refreshBotActivity(bot);
    this.emit({ type: "bot", botId });
    return bot;
  }

  setTaskActivity(botId: string, threadId: string, activity: BotActivity): BotRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    const busy = ACTIVITY_BUSY.has(activity);
    if ((task.activity ?? "idle") === activity && Boolean(task.busy) === busy) return bot;
    const wasBusy = Boolean(task.busy);
    const wasWaiting = task.activity === "waiting-on-you";
    task.activity = activity;
    task.busy = busy;
    if (busy && !wasBusy) task.turnStartedAt = Date.now();
    else if (!busy) delete task.turnStartedAt;
    if (!busy || activity === "waiting-on-you") delete task.workingStartedAt;
    else if (!wasBusy || wasWaiting) task.workingStartedAt = Date.now();
    if (task.snoozedUntil === 0) {
      task.snoozedUntil = undefined;
      this.saveBots();
    }
    this.refreshBotActivity(bot);
    this.emit({ type: "bot", botId });
    return bot;
  }

  private refreshBotActivity(bot: BotRecord) {
    const activities = [this.legacyActivities.get(bot.id), ...(bot.tasks ?? []).map((task) => task.activity)];
    bot.activity = (["waiting-on-you", "no-signal", "working", "dead"] as const)
      .find((activity) => activities.includes(activity)) ?? "idle";
    bot.busy = ACTIVITY_BUSY.has(bot.activity);
  }

  mainBotId(): string | null {
    if (this.mainId && this.bot(this.mainId)) return this.mainId;
    return mainDogId(this.bots, this.mainId, this.sections);
  }

  setMainBot(id: string): BotRecord[] | null {
    if (!this.bot(id)) return null;
    this.mainId = id;
    return this.saveSettledMainDog();
  }

  private settleMainDog(): BotRecord[] {
    this.mainId = mainDogId(this.bots, this.mainId, this.sections);
    const changed: BotRecord[] = [];
    for (const bot of this.bots) {
      const main = bot.id === this.mainId;
      const legacy = bot as BotRecord & { managedSections?: unknown };
      if (Boolean(bot.chiefOfStaff) === main && legacy.managedSections === undefined) continue;
      bot.chiefOfStaff = main;
      delete legacy.managedSections;
      changed.push(bot);
    }
    return changed;
  }

  private saveSettledMainDog(announcedLater?: string): BotRecord[] {
    const changed = this.settleMainDog();
    if (!changed.length) return changed;
    this.saveBots();
    for (const bot of changed) if (bot.id !== announcedLater) this.emit({ type: "bot", botId: bot.id });
    return changed;
  }

  renameInstances(ids: ReadonlyMap<string, string>): number {
    const touches = (record?: Record<string, unknown>) => Boolean(record && Object.keys(record).some(key => ids.has(key)));
    const rename = <T>(record: Record<string, T>): Record<string, T> => {
      const next: Record<string, T> = {};
      for (const [key, value] of Object.entries(record)) {
        const target = ids.get(key);
        if (!target) next[key] = value;
        else if (!Object.prototype.hasOwnProperty.call(record, target)) next[target] = value;
      }
      return next;
    };
    const changed: BotRecord[] = [];
    for (const bot of this.bots) {
      let dirty = false;
      const selected = ids.get(bot.modelSelection.instanceId);
      if (selected) { bot.modelSelection = { ...bot.modelSelection, instanceId: selected }; dirty = true; }
      if (touches(bot.resumeCursors)) { bot.resumeCursors = rename(bot.resumeCursors); dirty = true; }
      for (const task of bot.tasks ?? []) {
        const taskSelected = task.modelSelection && ids.get(task.modelSelection.instanceId);
        if (task.modelSelection && taskSelected) { task.modelSelection = { ...task.modelSelection, instanceId: taskSelected }; dirty = true; }
        if (touches(task.resumeCursors)) { task.resumeCursors = rename(task.resumeCursors); dirty = true; }
        if (task.handedMessages && touches(task.handedMessages)) { task.handedMessages = rename(task.handedMessages); dirty = true; }
        const last = task.lastInstanceId && ids.get(task.lastInstanceId);
        if (last) { task.lastInstanceId = last; dirty = true; }
      }
      if (dirty) changed.push(bot);
    }
    if (changed.length) this.saveBots();
    for (const bot of changed) this.emit({ type: "bot", botId: bot.id });
    return changed.length;
  }

  retireInstances(ids: ReadonlySet<string>, replacement: ModelSelection, options: {
    driverKind?: string;
    canWorkOnCloud: boolean;
    keepCloud: (bot: BotRecord) => boolean;
  }): ComputerEngineMove[] {
    const retired = (selection?: { instanceId: string }) => Boolean(selection && ids.has(selection.instanceId));
    const without = <T>(record: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(record).filter(([key]) => !ids.has(key)));
    const touches = (record?: Record<string, unknown>) => Boolean(record && Object.keys(record).some(key => ids.has(key)));
    const needsAsk = (target: Parameters<typeof approvalModeFor>[0]) =>
      modelSwitchNeedsAsk(approvalModeFor(target), REMOVED_COMPUTER_DRIVER, options.driverKind);
    const askNow = { approvalMode: "ask" as const, autoApprove: false, alwaysAllow: [] as string[] };
    const changes: Array<{ bot: BotRecord; patch: Partial<BotRecord>; tasks: Partial<TaskRecord>[] }> = [];
    const moves: ComputerEngineMove[] = [];
    for (const bot of this.bots) {
      const patch: Partial<BotRecord> = {};
      const tasks = (bot.tasks ?? []).map((): Partial<TaskRecord> => ({}));
      const botMoved = retired(bot.modelSelection);
      const keepsCloud = options.canWorkOnCloud && options.keepCloud(bot);
      let botAsk = false;
      if (botMoved) {
        if (bot.computer === undefined && keepsCloud) patch.computer = "cloud";
        if (needsAsk(bot)) { Object.assign(patch, structuredClone(askNow)); botAsk = true; }
        patch.modelSelection = structuredClone(replacement);
      }
      if (bot.fallback?.some(retired)) {
        const kept = bot.fallback.filter(candidate => !retired(candidate));
        patch.fallback = kept.length ? kept : undefined;
      }
      if (touches(bot.resumeCursors)) patch.resumeCursors = without(bot.resumeCursors);
      const computer = patch.computer ?? bot.computer;
      const cloudAfterMove = (pin: TaskRecord["surface"], pinSource: TaskRecord["surfaceSource"]): Pick<ComputerEngineMove, "cloud" | "noComputer"> => {
        const place = pin ?? bot.computer;
        const wasCloud = place === "cloud" || (place === undefined && options.keepCloud(bot));
        if (!wasCloud || options.canWorkOnCloud) return { cloud: wasCloud, noComputer: false };
        const personPin = pin !== undefined && pinSource !== "auto";
        const still = personPin ? pin : bot.computer;
        return { cloud: false, noComputer: still !== "cloud" ? "auto" : personPin ? "pin" : "works-on" };
      };
      (bot.tasks ?? []).forEach((task, index) => {
        const taskPatch = tasks[index]!;
        const before = this.projectBotForTask(bot.id, task.threadId)!;
        if (botAsk) {
          Object.assign(taskPatch, {
            approvalMode: before.approvalMode, autoApprove: before.autoApprove, alwaysAllow: structuredClone(before.alwaysAllow ?? []),
          });
        }
        const moved = task.modelSelection ? retired(task.modelSelection) : botMoved;
        if (moved) {
          if (!botMoved && computer === undefined && task.surface === undefined && keepsCloud) {
            taskPatch.surface = "cloud";
            taskPatch.surfaceSource = "auto";
          }
          if (!options.canWorkOnCloud && task.surface === "cloud" && task.surfaceSource === "auto") {
            taskPatch.surface = undefined;
            taskPatch.surfaceSource = undefined;
          }
          const ask = needsAsk(before);
          if (ask) Object.assign(taskPatch, structuredClone(askNow));
          if (task.modelSelection) taskPatch.modelSelection = structuredClone(replacement);
          const scope = botMoved && task.threadId === bot.threadId ? "bot" : "conversation";
          moves.push({ botId: bot.id, threadId: task.threadId, scope, ...cloudAfterMove(task.surface, task.surfaceSource),
            askNow: ask || (scope === "bot" && botAsk) });
        } else if (botMoved && task.threadId === bot.threadId) {
          moves.push({ botId: bot.id, threadId: task.threadId, scope: "bot-only", ...cloudAfterMove(undefined, undefined), askNow: botAsk });
        }
        if (touches(task.resumeCursors)) taskPatch.resumeCursors = without(task.resumeCursors);
        if (task.handedMessages && touches(task.handedMessages)) taskPatch.handedMessages = without(task.handedMessages);
      });
      if (Object.keys(patch).length || tasks.some(taskPatch => Object.keys(taskPatch).length)) changes.push({ bot, patch, tasks });
    }
    if (!changes.length) return moves;
    const next = new Map(changes.map(({ bot, patch, tasks }) => [bot, {
      ...bot, ...patch, tasks: bot.tasks?.map((task, index) => ({ ...task, ...tasks[index] })),
    }]));
    this.saveBots(this.bots.map(bot => next.get(bot) ?? bot));
    for (const { bot, patch, tasks } of changes) {
      bot.tasks?.forEach((task, index) => Object.assign(task, tasks[index]));
      Object.assign(bot, patch);
      this.emit({ type: "bot", botId: bot.id });
    }
    return moves;
  }

  setResumeCursor(botId: string, instanceId: string, cursor: unknown, threadId?: string) {
    const bot = this.bot(botId);
    if (!bot) return;
    const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
    if (task) task.resumeCursors[instanceId] = cursor;
    if (!threadId || bot.threadId === threadId) bot.resumeCursors[instanceId] = cursor;
    this.saveBots();
    this.emit({ type: "bot", botId });
  }

  markTaskDispatched(botId: string, threadId: string, instanceId: string) {
    const task = this.taskByThread(botId, threadId);
    if (!task || task.lastInstanceId === instanceId) return;
    task.lastInstanceId = instanceId;
    this.saveBots();
  }

  setHandedMessages(botId: string, threadId: string, instanceId: string, state: HandedState) {
    const task = this.taskByThread(botId, threadId);
    if (!task || JSON.stringify(task.handedMessages?.[instanceId]) === JSON.stringify(state)) return;
    const live = Object.entries(task.handedMessages ?? {})
      .filter(([id, record]) => id !== instanceId && record.session !== undefined && record.session === task.resumeCursors[id]);
    task.handedMessages = { ...Object.fromEntries(live), [instanceId]: state };
    this.saveBots();
  }

  addTaskUsage(
    botId: string,
    threadId: string,
    turn: { input?: number; output?: number; cachedInput?: number; costUsd: number | null; context?: { tokens?: number; window?: number } },
  ): TaskUsage | null {
    const task = this.taskByThread(botId, threadId);
    if (!task) return null;
    const prev: TaskUsage = { input: 0, output: 0, costUsd: null, turns: 0, ...task.usage };
    const cost = typeof turn.costUsd === "number" && Number.isFinite(turn.costUsd) ? turn.costUsd : null;
    const prevCost = typeof prev.costUsd === "number" ? prev.costUsd : null;
    const clean = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
    const cachedKnown = typeof prev.cachedInput === "number" || typeof turn.cachedInput === "number";
    const prevInput = clean(prev.input);
    const turnInput = clean(turn.input);
    const nextCachedInput = Math.min(clean(prev.cachedInput), prevInput)
      + Math.min(clean(turn.cachedInput), turnInput);
    const contextTokens = clean(turn.context?.tokens);
    const contextWindow = clean(turn.context?.window);
    task.usage = {
      input: prevInput + turnInput,
      output: prev.output + clean(turn.output),
      ...(cachedKnown ? { cachedInput: nextCachedInput } : {}),
      costUsd: cost === null ? prevCost : (prevCost ?? 0) + cost,
      turns: prev.turns + 1,
      lastTurn: {
        input: turnInput, output: clean(turn.output),
        ...(typeof turn.cachedInput === "number" ? { cachedInput: Math.min(clean(turn.cachedInput), turnInput) } : {}),
        costUsd: cost,
      },
      ...(contextTokens > 0
        ? { context: { tokens: contextTokens, ...(contextWindow > 0 ? { window: contextWindow } : {}) } }
        : prev.context ? { context: prev.context } : {}),
    };
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task.usage;
  }

  unpinTaskCwd(threadId: string): boolean {
    const bot = this.botByThread(threadId);
    const task = bot ? this.taskByThread(bot.id, threadId) : undefined;
    if (!bot || !task || task.cwd === undefined) return false;
    delete task.cwd;
    this.saveBots();
    this.emit({ type: "bot", botId: bot.id });
    return true;
  }

  pinTaskCwd(botId: string, threadId: string, fallbackCwd?: string, opts: { none?: boolean; privateOnly?: boolean } = {}): string | null {
    const bot = this.bot(botId);
    const task = bot ? this.taskByThread(botId, threadId) : undefined;
    if (!bot || !task) return null;
    if (opts.privateOnly && task.cwd === undefined) {
      task.cwd = fallbackCwd ?? null;
      this.saveBots();
      this.emit({ type: "bot", botId });
      return task.cwd;
    }
    if (opts.none) {
      if (task.cwd !== null) {
        task.cwd = null;
        this.saveBots();
        this.emit({ type: "bot", botId });
      }
      return null;
    }
    if (task.cwd === undefined) {
      task.cwd = Object.keys(task.resumeCursors).length === 0 ? (bot.cwd ?? fallbackCwd ?? null) : null;
      this.saveBots();
      this.emit({ type: "bot", botId });
    }
    return task.cwd;
  }

  pinGroupCwd(groupId: string, threadId?: string): string | null {
    const group = this.group(groupId);
    if (!group) return null;
    const task = threadId ? this.groupTaskByThread(groupId, threadId) : this.activeGroupTask(groupId);
    if (!task) {
      if (!group.dm) return null;
      if (group.pinnedCwd === undefined) {
        group.pinnedCwd = group.cwd ?? null;
        this.saveGroups();
        this.emit({ type: "group", groupId: group.id });
      }
      return group.pinnedCwd;
    }
    if (task.pinnedCwd === undefined) {
      task.pinnedCwd = group.cwd ?? null;
      if (group.threadId === task.threadId) group.pinnedCwd = task.pinnedCwd;
      this.saveGroups();
      this.emit({ type: "group", groupId: group.id });
    }
    return task.pinnedCwd;
  }

  project(botId: string, projectId: string): BotProjectRecord | undefined {
    return this.bot(botId)?.projects?.find((project) => project.id === projectId);
  }

  createProject(botId: string, name: string, emoji?: string | null): BotProjectRecord | null {
    const bot = this.bot(botId);
    if (!bot || !name.trim() || (emoji != null && !isProjectEmoji(emoji))) return null;
    const project: BotProjectRecord = {
      id: newId(), name: name.trim().slice(0, 80),
      ...(emoji == null ? {} : { emoji }),
    };
    bot.projects = [...(bot.projects ?? []), project];
    this.saveBots();
    this.emit({ type: "bot", botId });
    return project;
  }

  patchProject(botId: string, projectId: string, patch: { name?: string; emoji?: string | null }): BotProjectRecord | null {
    const project = this.project(botId, projectId);
    if (!project || (patch.name !== undefined && !patch.name.trim()) || (patch.emoji != null && !isProjectEmoji(patch.emoji))) return null;
    if (patch.name !== undefined) project.name = patch.name.trim().slice(0, 80);
    if (patch.emoji === null) delete project.emoji;
    else if (patch.emoji !== undefined) project.emoji = patch.emoji;
    this.saveBots();
    this.emit({ type: "bot", botId });
    return project;
  }

  reorderProjects(botId: string, projectIds: string[]): BotProjectRecord[] | null {
    const bot = this.bot(botId);
    const projects = bot?.projects ?? [];
    if (!bot || projectIds.length !== projects.length || new Set(projectIds).size !== projects.length) return null;
    const byId = new Map(projects.map((project) => [project.id, project]));
    if (projectIds.some((id) => !byId.has(id))) return null;
    bot.projects = projectIds.map((id) => byId.get(id)!);
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot.projects;
  }

  deleteProject(botId: string, projectId: string): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot || !this.project(botId, projectId)) return null;
    bot.projects = bot.projects!.filter((project) => project.id !== projectId);
    for (const task of bot.tasks ?? []) {
      if (task.projectId === projectId) delete task.projectId;
    }
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot;
  }

  private firstUserLine(threadId: string): string | null {
    const first = this.messagesFor(threadId).find((m) => m.role === "user" && m.kind === "text" && m.text?.trim());
    return first?.text ? titleFromMessage(first.text) : null;
  }

  tasks(botId: string): TaskRecord[] {
    return this.bot(botId)?.tasks ?? [];
  }

  activeTask(botId: string): TaskRecord | undefined {
    const bot = this.bot(botId);
    return bot?.tasks?.find((t) => t.threadId === bot.threadId);
  }

  taskByThread(botId: string, threadId: string): TaskRecord | undefined {
    return this.bot(botId)?.tasks?.find((t) => t.threadId === threadId);
  }

  projectBotForTask(botId: string, threadId: string): BotRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    return {
      ...bot,
      threadId: task.threadId,
      approvalGrant: bot.approvalGrant?.threadOnly && bot.approvalGrant.threadId !== threadId ? undefined : bot.approvalGrant,
      modelSelection: structuredClone(task.modelSelection ?? bot.modelSelection),
      resumeCursors: structuredClone(task.resumeCursors),
      approvalMode: task.approvalMode ?? (task.autoApprove === undefined ? bot.approvalMode : undefined),
      autoApprove: task.autoApprove ?? bot.autoApprove,
      alwaysAllow: structuredClone(task.alwaysAllow ?? bot.alwaysAllow),
      unread: Boolean(task.unread),
      rewound: task.rewound,
      pinnedMessageId: task.pinnedMessageId,
      activity: task.activity ?? "idle",
      busy: Boolean(task.busy),
    };
  }

  patchTask(botId: string, threadId: string, patch: TaskPatch): TaskRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    if (patch.projectId !== undefined && !this.project(botId, patch.projectId)) return null;
    for (const key of TASK_PATCH_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        Object.assign(task, { [key]: structuredClone(patch[key]) });
      }
    }
    if (task.snoozedUntil === 0 && patch.unread === true) task.snoozedUntil = undefined;
    if (typeof patch.title === "string") task.title = patch.title.trim().slice(0, 80) || UNTITLED_THREAD;
    if (Object.prototype.hasOwnProperty.call(patch, "pinned") && task.pinned !== true) delete task.pinned;
    if (task.routineRunId) task.unread = false;
    if (bot.threadId === threadId) this.mirrorActiveTask(bot, task);
    bot.unread = bot.tasks!.some(taskCountsAsBotUnread);
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  clearAutoSurfacePins(botId: string, destination: Destination): number {
    const bot = this.bot(botId);
    if (!bot?.tasks) return 0;
    let cleared = 0;
    for (const task of bot.tasks) {
      if (task.surface === undefined || task.surfaceSource !== "auto" || task.surface === destination) continue;
      task.surface = undefined;
      task.surfaceSource = undefined;
      cleared++;
    }
    if (!cleared) return 0;
    this.saveBots();
    this.emit({ type: "bot", botId });
    return cleared;
  }

  switchTaskModel(botId: string, threadId: string, selection: ModelSelection,
    updateBotDefault: boolean, resetApprovalToAsk: boolean, taskPatch: TaskPatch = {}): TaskRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    const approval = resetApprovalToAsk ? structuredClone(ASK_NOW) : {};
    const own = sameModelSelection(selection, updateBotDefault ? selection : bot.modelSelection) ? undefined : structuredClone(selection);
    const nextTask = persistedPin({ ...task, ...taskPatch, modelSelection: own, ...approval,
      ...(typeof taskPatch.title === "string" ? { title: taskPatch.title.trim().slice(0, 80) || UNTITLED_THREAD } : {}) });
    const others = updateBotDefault ? this.withDefaultModel(bot, selection)! : bot.tasks!;
    const nextTasks = bot.tasks!.map((candidate, index) => candidate === task ? nextTask : others[index]!);
    const botPatch = updateBotDefault ? { modelSelection: structuredClone(selection), ...approval } : {};
    this.saveBots(this.bots.map((candidate) => candidate === bot ? { ...bot, ...botPatch, tasks: nextTasks } : candidate));
    bot.tasks!.forEach((candidate, index) => Object.assign(candidate, nextTasks[index]));
    Object.assign(bot, botPatch);
    this.emit({ type: "bot", botId });
    return task;
  }

  followBotModel(botId: string, threadIds: readonly string[],
    reset: (from: ModelSelection, to: ModelSelection) => Partial<TaskRecord> = () => ({})): string[] {
    const bot = this.bot(botId);
    if (!bot?.tasks) return [];
    const listed = new Set(threadIds);
    const patches = bot.tasks.map((task): Partial<TaskRecord> | null => !listed.has(task.threadId) || task.modelSelection === undefined ? null : {
      ...reset(task.modelSelection, bot.modelSelection),
      modelSelection: undefined,
      ...(this.switchNeedsAsk(botId, task.threadId, task.modelSelection, bot.modelSelection) ? structuredClone(ASK_NOW) : {}),
    });
    const moved = bot.tasks.filter((_, index) => patches[index]).map((task) => task.threadId);
    if (!moved.length) return [];
    const nextTasks = bot.tasks.map((task, index) => patches[index] ? { ...task, ...patches[index] } : task);
    this.saveBots(this.bots.map((candidate) => candidate === bot ? { ...bot, tasks: nextTasks } : candidate));
    bot.tasks.forEach((task, index) => { if (patches[index]) Object.assign(task, patches[index]); });
    const active = bot.tasks.find((task) => task.threadId === bot.threadId);
    if (active) this.mirrorActiveTask(bot, active);
    this.emit({ type: "bot", botId });
    return moved;
  }

  setAllThreadApprovalMode(botId: string, mode: "full" | "ask"): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    const patch = { approvalMode: mode, autoApprove: false, alwaysAllow: [] };
    const tasks = (bot.tasks ?? []).map(task => ({ ...task, ...patch }));
    const next = { ...bot, ...patch, approvalGrant: undefined, tasks };
    this.saveBots(this.bots.map(candidate => candidate === bot ? next : candidate));
    bot.tasks?.forEach((task, index) => Object.assign(task, tasks[index]));
    Object.assign(bot, patch, { approvalGrant: undefined });
    this.emit({ type: "bot", botId });
    return bot;
  }

  refreshTaskPermissions(botId: string, threadId: string): TaskRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    const mode = approvalModeFor({ ...bot, approvalGrant: undefined });
    const alwaysAllow = structuredClone(bot.alwaysAllow ?? []);
    const autoApprove = mode === "auto";
    const sameAllow = JSON.stringify(task.alwaysAllow ?? []) === JSON.stringify(alwaysAllow);
    if (task.approvalMode === mode && task.autoApprove === autoApprove && sameAllow) return task;
    return this.patchTask(botId, threadId, { approvalMode: mode, autoApprove, alwaysAllow });
  }

  private mirrorActiveTask(bot: BotRecord, task: TaskRecord) {
    bot.threadId = task.threadId;
    bot.resumeCursors = structuredClone(task.resumeCursors);
    bot.rewound = task.rewound;
    bot.pinnedMessageId = task.pinnedMessageId;
  }

  createTask(botId: string, title?: string, activate = true, projectId?: string, openedBy?: TaskOpenedBy, approvalMode?: "ask" | "full",
    modelSelection?: ModelSelection): TaskRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    if (projectId !== undefined && !this.project(botId, projectId)) return null;
    const createdAt = Date.now();
    const task: TaskRecord = {
      threadId: newId(),
      title: threadTitleFrom(title),
      createdAt,
      updatedAt: createdAt,
      ...(projectId ? { projectId } : {}),
      ...(openedBy ? { openedBy: structuredClone(openedBy) } : {}),
      resumeCursors: {},
      ...(modelSelection && !sameModelSelection(modelSelection, bot.modelSelection) ? { modelSelection: structuredClone(modelSelection) } : {}),
      approvalMode: approvalMode ?? approvalModeFor(bot),
      autoApprove: approvalMode ? false : Boolean(bot.autoApprove),
      alwaysAllow: approvalMode ? [] : [...(bot.alwaysAllow ?? [])],
      unread: false,
      activity: "idle",
      busy: false,
    };
    bot.tasks = [task, ...(bot.tasks ?? [])];
    if (activate) {
      this.mirrorActiveTask(bot, task);
    }
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  setTaskOpenedBy(botId: string, threadId: string, openedBy: TaskOpenedBy): TaskRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    task.openedBy = structuredClone(openedBy);
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  setTaskClosedBy(botId: string, threadId: string, closedBy: TaskClosedBy | null): TaskRecord | null {
    const bot = this.bot(botId);
    const task = this.taskByThread(botId, threadId);
    if (!bot || !task) return null;
    if (closedBy) task.closedBy = structuredClone(closedBy);
    else if (!task.closedBy) return task;
    else delete task.closedBy;
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  switchTask(botId: string, threadId: string): BotRecord | null {
    const bot = this.bot(botId);
    const task = bot?.tasks?.find((t) => t.threadId === threadId);
    if (!bot || !task) return null;
    this.mirrorActiveTask(bot, task);
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot;
  }

  renameTask(botId: string, threadId: string, title: string): TaskRecord | null {
    return this.patchTask(botId, threadId, { title });
  }

  titleTaskFromFirstMessage(botId: string, text: string, threadId?: string): TaskRecord | null {
    const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
    if (!task || task.titleFromFirstMessage || (task.title !== UNTITLED_TASK && task.title !== UNTITLED_THREAD)) return null;
    task.title = titleFromMessage(text);
    task.titleFromFirstMessage = true;
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  retitleTask(botId: string, threadId: string, machineTitle: string, title: string): TaskRecord | null {
    const task = this.taskByThread(botId, threadId);
    if (!task || task.title !== machineTitle) return null;
    return this.renameTask(botId, threadId, threadTitleFrom(title));
  }

  deleteTask(botId: string, threadId: string): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot?.tasks) return null;
    if (!bot.tasks.some((t) => t.threadId === threadId)) return null;
    bot.tasks = bot.tasks.filter((t) => t.threadId !== threadId);
    const visible = bot.tasks.find((task) => !task.routineRunId)
      ?? this.createTask(botId, undefined, bot.threadId === threadId)!;
    if (bot.threadId === threadId || this.taskByThread(botId, bot.threadId)?.routineRunId) {
      this.mirrorActiveTask(bot, visible);
    }
    this.deleteThreadRecord(threadId);
    bot.unread = bot.tasks.some(taskCountsAsBotUnread);
    this.refreshBotActivity(bot);
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot;
  }

  needsSeed() {
    return this.bots.length === 0 && !this.damaged.some((file) => file.name === "bots");
  }

  seedIfEmpty() {
    if (!this.needsSeed()) return;
    this.createBot();
  }
}
