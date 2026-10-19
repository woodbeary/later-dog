import type { AppState, Bot, Group, Message } from "@/state/store";
import { mainDogId } from "../../shared/main-dog";
import type { SessionState } from "./session";

export const FIRST_PAINT_KEY = "laterdog-first-paint";
export const FIRST_PAINT_VERSION = 1;
export const FIRST_PAINT_MAX_CHARS = 2_000_000;
export const FIRST_PAINT_MESSAGES = 50;
export const FIRST_PAINT_SAVE_DELAY_MS = 1_000;

export interface FirstPaintOwner {
  origin: string;
  account: string;
}

export interface FirstPaintSnapshot {
  version: typeof FIRST_PAINT_VERSION;
  owner: FirstPaintOwner;
  savedAt: number;
  selectedId: string;
  sections: string[];
  bots: Bot[];
  groups: Group[];
}

export type FirstPaintSource = Pick<AppState, "bots" | "groups" | "sections" | "selectedId">;

function storage(explicit?: Storage): Storage | undefined {
  if (explicit) return explicit;
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function pageOrigin(): string | null {
  try {
    return typeof location === "undefined" ? null : location.origin;
  } catch {
    return null;
  }
}

function viewerOf(session: SessionState | null): string | null {
  if (session?.kind === "loopback") return session.trust === "service" ? null : "this-computer";
  if (session?.kind !== "session") return null;
  return session.email ? `email:${session.email.toLowerCase()}` : `session:${session.id}`;
}

export function accountOf(session: SessionState | null): string | null {
  const viewer = viewerOf(session);
  if (!viewer || !session || (session.kind !== "loopback" && session.kind !== "session")) return null;
  return session.environmentId ? `${session.environmentId}/${viewer}` : viewer;
}

export function ownsFirstPaint(snapshot: FirstPaintSnapshot, owner: FirstPaintOwner): boolean {
  return snapshot.owner.origin === owner.origin && snapshot.owner.account === owner.account;
}

function stillMessage(message: Message): Message {
  const { png: _png, ...rest } = message;
  return rest.tool?.statusLine === "live" ? { ...rest, tool: { ...rest.tool, statusLine: "folded" } } : rest;
}

function newest<T extends { messages: Message[]; hasMore?: boolean }>(owner: T): T {
  const kept = owner.messages.slice(-FIRST_PAINT_MESSAGES).map(stillMessage);
  const trimmed = kept.length < owner.messages.length;
  return { ...owner, messages: kept, hasMore: Boolean(owner.hasMore) || trimmed };
}

function restingBot(bot: Bot): Bot {
  return newest({
    ...bot,
    busy: false,
    turnStartedAt: null,
    workingStartedAt: null,
    activity: bot.activity === "working" ? "idle" : bot.activity,
    tasks: bot.tasks?.map((task) => ({
      ...task,
      busy: false,
      turnStartedAt: undefined,
      workingStartedAt: undefined,
      activity: task.activity === "working" ? "idle" : task.activity,
    })),
  });
}

function restingGroup(group: Group): Group {
  return newest({ ...group, busyBotId: null, working: false, turnStartedAt: null });
}

const lastAt = (messages: Message[], fallback: number) => messages.at(-1)?.at ?? fallback;

export function firstPaintSnapshot(source: FirstPaintSource, owner: FirstPaintOwner, now: number): string | null {
  const bots = source.bots.map(restingBot);
  const groups = source.groups.map(restingGroup);
  const snapshot: FirstPaintSnapshot = {
    version: FIRST_PAINT_VERSION,
    owner,
    savedAt: now,
    selectedId: source.selectedId,
    sections: source.sections ?? [],
    bots,
    groups,
  };
  let serialized = JSON.stringify(snapshot);
  if (serialized.length <= FIRST_PAINT_MAX_CHARS) return serialized;

  const emptied = <T extends { messages: Message[]; hasMore?: boolean }>(owner: T): T => ({ ...owner, messages: [], hasMore: true });
  const saving = (owner: object, cleared: object) => JSON.stringify(owner).length - JSON.stringify(cleared).length;
  const threads = [
    ...bots.map((bot, index) => {
      const cleared = emptied(bot);
      return { id: bot.id, at: lastAt(bot.messages, 0), clear: () => { bots[index] = cleared; }, saves: saving(bot, cleared) };
    }),
    ...groups.map((group, index) => {
      const cleared = emptied(group);
      return { id: group.id, at: lastAt(group.messages, group.createdAt), clear: () => { groups[index] = cleared; }, saves: saving(group, cleared) };
    }),
  ]
    .filter((thread) => thread.id !== source.selectedId && thread.saves > 0)
    .sort((left, right) => left.at - right.at);
  let excess = serialized.length - FIRST_PAINT_MAX_CHARS;
  for (const thread of threads) {
    if (excess <= 0) break;
    thread.clear();
    excess -= thread.saves;
  }
  serialized = JSON.stringify({ ...snapshot, bots, groups });
  return serialized.length <= FIRST_PAINT_MAX_CHARS ? serialized : null;
}

function validOwner(value: unknown): value is FirstPaintOwner {
  return isRecord(value) && typeof value.origin === "string" && typeof value.account === "string";
}

function validConversation(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && typeof value.threadId === "string" &&
    typeof value.name === "string" && Array.isArray(value.messages);
}

export function parseFirstPaint(raw: string | null, origin: string): FirstPaintSnapshot | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== FIRST_PAINT_VERSION || !validOwner(parsed.owner)) return null;
    if (parsed.owner.origin !== origin) return null;
    if (!Array.isArray(parsed.bots) || !Array.isArray(parsed.groups) || !Array.isArray(parsed.sections)) return null;
    if (!parsed.bots.every(validConversation) || !parsed.groups.every(validConversation)) return null;
    if (!parsed.sections.every((section) => typeof section === "string")) return null;
    return {
      version: FIRST_PAINT_VERSION,
      owner: parsed.owner,
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
      selectedId: typeof parsed.selectedId === "string" ? parsed.selectedId : "",
      sections: parsed.sections as string[],
      bots: parsed.bots as Bot[],
      groups: parsed.groups as Group[],
    };
  } catch {
    return null;
  }
}

let lastRead: { raw: string; origin: string; snapshot: FirstPaintSnapshot } | null = null;

export function readFirstPaint(origin: string | null, explicit?: Storage): FirstPaintSnapshot | null {
  if (!origin) return null;
  const store = storage(explicit);
  let raw: string | null = null;
  try {
    raw = store?.getItem(FIRST_PAINT_KEY) ?? null;
  } catch {
    return null;
  }
  if (raw && lastRead && lastRead.raw === raw && lastRead.origin === origin) return lastRead.snapshot;
  const snapshot = parseFirstPaint(raw, origin);
  if (raw && !snapshot) forgetFirstPaint(explicit);
  lastRead = raw && snapshot ? { raw, origin, snapshot } : null;
  return snapshot;
}

export function saveFirstPaint(serialized: string, explicit?: Storage): boolean {
  const store = storage(explicit);
  if (!store) return false;
  try {
    store.setItem(FIRST_PAINT_KEY, serialized);
    return true;
  } catch {
    forgetFirstPaint(explicit);
    return false;
  }
}

export function forgetFirstPaint(explicit?: Storage): void {
  lastRead = null;
  try {
    storage(explicit)?.removeItem(FIRST_PAINT_KEY);
  } catch {}
}

export function withFirstPaint(base: AppState, snapshot: FirstPaintSnapshot): AppState {
  const known = (id: string) => snapshot.bots.some((bot) => bot.id === id) || snapshot.groups.some((group) => group.id === id);
  return {
    ...base,
    restored: true,
    bots: snapshot.bots,
    groups: snapshot.groups,
    sections: snapshot.sections,
    selectedId: known(snapshot.selectedId) ? snapshot.selectedId : (mainDogId(snapshot.bots) ?? ""),
  };
}
