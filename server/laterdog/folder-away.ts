import { existsSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AWAY_MARKER, AWAY_RULES, freeShare, pressureOrder, timerOrder, type AwayPlan, type AwayRules, type Disk, type PlannedChat } from "./folder-away-plan.ts";

export const BRINGING_BACK_LINE = "Bringing this chat's files back";
export const BRING_BACK_FAILED_LINE = "This chat's files are in Cloud storage and couldn't be brought back yet; trying again";
export const BRING_BACK_ROOM_LINE = "This chat's files are in Cloud storage and there isn't enough free space to bring them back yet; making room and trying again";
export const WANTED_HOLD_MS = 60 * 60_000;
export const SWEEP_EVERY_MS = 24 * 60 * 60_000;
export const PRESSURE_CHECK_MS = 10 * 60_000;
export const LOW_BYTES = 2 * 1024 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const BRIDGE_TIMEOUT_MS = 60 * 60_000;

export interface AwayChatStatus { botId: string; threadId: string; files: number; bytes: number; movedAt: string; released: boolean }
export interface AwayStatus { away: number; bytes: number; released: number; chats: AwayChatStatus[] }
export interface Packed { id: string; record: string; files: number; bytes: number }
export interface Swapped { moved?: true; kept?: string; files?: number; bytes?: number; freed?: number }
export interface Brought { here?: true; back?: true; beside?: string; files?: number; bytes?: number; short?: { needBytes: number; freeBytes: number; bytes: number } }

export interface FolderAwayBridge {
  status(): Promise<AwayStatus | null>;
  pack(botId: string, threadId: string): Promise<Packed>;
  swap(id: string): Promise<Swapped>;
  bringBack(botId: string, threadId: string): Promise<Brought>;
  release(botId: string, threadId: string): Promise<{ released: boolean }>;
}

export function folderAwayBridge(url: string, token: string, fetcher: typeof fetch = fetch): FolderAwayBridge {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.username || endpoint.password || endpoint.pathname !== "/") {
    throw new Error("archive service must use loopback");
  }
  const call = async <T>(path: string, payload?: Record<string, string>): Promise<T | null> => {
    const response = await fetcher(new URL(path, endpoint), {
      method: payload ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, ...(payload ? { "content-type": "application/json" } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? `archive service refused: ${response.status}`);
    return await response.json() as T;
  };
  const must = async <T>(path: string, payload?: Record<string, string>): Promise<T> => {
    const answer = await call<T>(path, payload);
    if (answer === null) throw new Error("this home's image cannot move chat folders");
    return answer;
  };
  return {
    status: () => call<AwayStatus>("folders/status"),
    pack: (botId, threadId) => must<Packed>("folders/pack", { botId, threadId }),
    swap: (id) => must<Swapped>("folders/swap", { id }),
    bringBack: (botId, threadId) => must<Brought>("folders/bring-back", { botId, threadId }),
    release: (botId, threadId) => must<{ released: boolean }>("folders/release", { botId, threadId }),
  };
}

export interface FolderAwayOptions {
  bridge: FolderAwayBridge;
  tasksDir: string;
  enabled(): boolean;
  chat(botId: string, threadId: string): { exists: boolean; inUse: boolean };
  plan(): Promise<AwayPlan>;
  disk(): Disk | null;
  changed?(botId: string, threadId: string): void;
  log?(line: string): void;
  now?: () => number;
  retryMs?: number;
  maxRetryMs?: number;
  rules?: AwayRules;
  lowBytes?: number;
}

export interface BringAllBack { ok: boolean; brought: number; failed: number; message: string }

export function awayLine(away: number, bytes: number): string | null {
  if (!away) return null;
  const size = bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
  return `${away === 1 ? "1 chat's files are" : `${away} chats' files are`} kept in Cloud storage (${size}) and come back when the chat is used.`;
}

const keyOf = (botId: string, threadId: string) => `${botId}/${threadId}`;
const mb = (bytes: number) => `${Math.ceil(bytes / 1024 / 1024)} MB`;

export class FolderAwayCoordinator {
  private gates = new Map<string, Promise<unknown>>();
  private lines = new Map<string, string>();
  private wanted = new Map<string, number>();
  private sweeping: Promise<void> | null = null;
  private supported: boolean | null = null;
  private lastStatus: AwayStatus | null = null;
  private lastMove: { at: number; moved: number; bytes: number; kept: number; failed: number } | null = null;
  private readonly options: FolderAwayOptions;
  private readonly now: () => number;
  private readonly rules: AwayRules;
  constructor(options: FolderAwayOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.rules = options.rules ?? AWAY_RULES;
  }

  private log(line: string) { this.options.log?.(line); }

  private gate<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.gates.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.gates.set(key, next);
    return next.finally(() => { if (this.gates.get(key) === next) this.gates.delete(key); });
  }

  private setLine(botId: string, threadId: string, line: string | null) {
    if ((this.lines.get(threadId) ?? null) === line) return;
    if (line) this.lines.set(threadId, line);
    else this.lines.delete(threadId);
    this.options.changed?.(botId, threadId);
  }

  line(threadId: string): string | undefined {
    return this.lines.get(threadId);
  }

  folderOf(botId: string, threadId: string): string {
    return join(this.options.tasksDir, botId, threadId);
  }

  isAway(botId: string, threadId: string): boolean {
    if (!ID.test(botId) || !ID.test(threadId)) return false;
    return existsSync(join(this.folderOf(botId, threadId), AWAY_MARKER));
  }

  chatOfPath(path: string): { botId: string; threadId: string } | null {
    let root = this.options.tasksDir;
    let target = path;
    try { root = realpathSync(root); } catch {}
    try { target = realpathSync(path); } catch {}
    for (const [base, at] of [[this.options.tasksDir, path], [root, target]] as const) {
      const rel = relative(base, at);
      if (!rel || rel.startsWith("..") || rel.startsWith(sep)) continue;
      const [botId, threadId] = rel.split(sep);
      if (botId && threadId && ID.test(botId) && ID.test(threadId)) return { botId, threadId };
    }
    return null;
  }

  async ensurePaths(paths: readonly (string | null | undefined)[], current: () => boolean = () => true): Promise<boolean> {
    for (const path of paths) {
      const chat = path ? this.chatOfPath(path) : null;
      if (chat && !await this.ensureChatFolder(chat.botId, chat.threadId, current)) return false;
    }
    return true;
  }

  async ensureChatFolder(botId: string, threadId: string, current: () => boolean = () => true): Promise<boolean> {
    if (!ID.test(botId) || !ID.test(threadId)) return true;
    const key = keyOf(botId, threadId);
    this.wanted.set(key, this.now());
    if (!this.isAway(botId, threadId) && !this.gates.has(key)) return true;
    let wait = this.options.retryMs ?? 5000;
    try {
      while (current()) {
        const outcome = await this.gate(key, async () => {
          if (!this.isAway(botId, threadId)) return "here" as const;
          this.setLine(botId, threadId, BRINGING_BACK_LINE);
          try {
            let answer = await this.options.bridge.bringBack(botId, threadId);
            if (answer.short) {
              await this.makeRoom(answer.short.needBytes, key);
              answer = await this.options.bridge.bringBack(botId, threadId);
            }
            if (answer.short) {
              this.log(`chat ${threadId}'s files need ${mb(answer.short.needBytes)} more free space before they can come back; trying again`);
              return "short" as const;
            }
            if (answer.beside) this.log(`chat ${threadId}'s files came back beside its folder as ${answer.beside}`);
            this.lastStatus = null;
            return "here" as const;
          } catch (error) {
            this.log(`could not bring back chat ${threadId}'s files yet: ${error instanceof Error ? error.message : String(error)}; trying again`);
            return "failed" as const;
          }
        });
        if (outcome === "here") return true;
        this.setLine(botId, threadId, outcome === "short" ? BRING_BACK_ROOM_LINE : BRING_BACK_FAILED_LINE);
        await delay(wait);
        wait = Math.min(wait * 2, this.options.maxRetryMs ?? 5 * 60_000);
      }
      return false;
    } finally {
      this.setLine(botId, threadId, null);
      this.wanted.set(key, this.now());
    }
  }

  private recentlyWanted(key: string): boolean {
    const at = this.wanted.get(key);
    return at !== undefined && this.now() - at < WANTED_HOLD_MS;
  }

  private async moveOne(chat: PlannedChat): Promise<"moved" | "kept" | "failed"> {
    const key = keyOf(chat.botId, chat.threadId);
    if (this.recentlyWanted(key) || this.gates.has(key)) return "kept";
    const stillIdle = () => {
      const state = this.options.chat(chat.botId, chat.threadId);
      return state.exists && !state.inUse && !this.recentlyWanted(key);
    };
    if (!stillIdle()) return "kept";
    try {
      const packed = await this.options.bridge.pack(chat.botId, chat.threadId);
      const swapped: Swapped = await this.gate(key, async (): Promise<Swapped> => (stillIdle() ? this.options.bridge.swap(packed.id) : { kept: "in-use" }));
      this.lastStatus = null;
      return swapped.moved ? "moved" : "kept";
    } catch (error) {
      this.log(`could not move chat ${chat.threadId}'s files: ${error instanceof Error ? error.message : String(error)}; they stay where they are`);
      return "failed";
    }
  }

  private async moveChats(chats: readonly PlannedChat[], enough: (freed: number) => boolean): Promise<number> {
    let freed = 0;
    let carried = 0;
    const tally = { at: this.now(), moved: 0, bytes: 0, kept: 0, failed: 0 };
    for (const chat of chats) {
      if (enough(freed)) break;
      if (carried > 0 && carried + chat.bytes > this.rules.passBytes) break;
      const outcome = await this.moveOne(chat);
      tally[outcome === "moved" ? "moved" : outcome] += 1;
      if (outcome !== "moved") continue;
      freed += chat.bytes;
      carried += chat.bytes;
      tally.bytes += chat.bytes;
    }
    if (tally.moved || tally.failed) this.lastMove = tally;
    return freed;
  }

  private async makeRoom(needBytes: number, exceptKey: string): Promise<number> {
    if (!await this.isSupported()) return 0;
    const plan = await this.options.plan();
    const candidates = [...plan.chats]
      .filter((chat) => keyOf(chat.botId, chat.threadId) !== exceptKey && ["moves", "moves-under-pressure", "would-move-under-pressure"].includes(chat.verdict))
      .sort((a, b) => b.bytes - a.bytes);
    return this.moveChats(candidates, (freed) => freed >= needBytes);
  }

  async isSupported(): Promise<boolean> {
    if (this.supported !== null) return this.supported;
    try {
      const status = await this.options.bridge.status();
      this.supported = status !== null;
      if (status) this.lastStatus = status;
      else this.log("this home's image cannot move chat folders; nothing will be moved");
    } catch {
      return false;
    }
    return this.supported;
  }

  sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.sweepOnce().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  private async sweepOnce(): Promise<void> {
    if (!await this.isSupported()) return;
    await this.releaseRemoved();
    if (!this.options.enabled()) return;
    const plan = await this.options.plan();
    const disk = this.options.disk();
    const pressured = disk !== null && freeShare(disk) < this.rules.pressureBelowShare;
    if (pressured && disk) {
      const target = this.rules.pressureUntilShare * disk.totalBytes - disk.freeBytes;
      const ordered = pressureOrder(plan.chats.map((chat) => chat.verdict === "moves" ? { ...chat, verdict: "would-move-under-pressure" as const } : chat));
      await this.moveChats(ordered, (freed) => freed >= target);
      return;
    }
    await this.moveChats(timerOrder(plan.chats), () => false);
  }

  pressureCheck(): Promise<void> | null {
    const disk = this.options.disk();
    if (!this.options.enabled() || !disk || freeShare(disk) >= this.rules.pressureBelowShare) return null;
    return this.sweep();
  }

  async releaseRemoved(): Promise<number> {
    this.lastStatus = null;
    const status = await this.status();
    let released = 0;
    for (const chat of status?.chats ?? []) {
      if (chat.released || this.options.chat(chat.botId, chat.threadId).exists) continue;
      try {
        if ((await this.options.bridge.release(chat.botId, chat.threadId)).released) released += 1;
      } catch (error) {
        this.log(`could not record that removed chat ${chat.threadId}'s stored files are no longer needed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (released) this.lastStatus = null;
    return released;
  }

  async status(): Promise<AwayStatus | null> {
    if (this.lastStatus) return this.lastStatus;
    try {
      const status = await this.options.bridge.status();
      this.supported = status !== null;
      this.lastStatus = status;
      return status;
    } catch {
      return null;
    }
  }

  report(): { supported: boolean | null; enabled: boolean; away: number; bytes: number; released: number; line: string | null; lastMove: FolderAwayCoordinator["lastMove"] } {
    if (!this.lastStatus) void this.status();
    const status = this.lastStatus;
    const away = status?.away ?? 0;
    const bytes = status?.bytes ?? 0;
    return { supported: this.supported, enabled: this.options.enabled(), away, bytes, released: status?.released ?? 0, line: awayLine(away, bytes), lastMove: this.lastMove };
  }

  async bringAllBack(): Promise<BringAllBack> {
    this.lastStatus = null;
    const status = await this.status();
    if (!status) return { ok: false, brought: 0, failed: 0, message: "This home's image cannot move chat folders, so none are away." };
    const waiting = status.chats.filter((chat) => !chat.released);
    if (!waiting.length) return { ok: true, brought: 0, failed: 0, message: "No chat's files are in Cloud storage." };
    const disk = this.options.disk();
    const needed = waiting.reduce((sum, chat) => sum + chat.bytes, 0);
    const room = disk ? disk.freeBytes - (this.options.lowBytes ?? LOW_BYTES) : 0;
    if (!disk || needed > room) {
      return { ok: false, brought: 0, failed: 0, message: `Not enough free space to bring every chat's files back: they need ${mb(needed)} and only ${mb(Math.max(0, room))} can be used without running the home low. Nothing was changed.` };
    }
    let brought = 0;
    let failed = 0;
    for (const chat of waiting) {
      const key = keyOf(chat.botId, chat.threadId);
      this.wanted.set(key, this.now());
      const outcome = await this.gate(key, async () => {
        try {
          const answer = await this.options.bridge.bringBack(chat.botId, chat.threadId);
          return answer.short ? "failed" : "back";
        } catch (error) {
          this.log(`could not bring back chat ${chat.threadId}'s files: ${error instanceof Error ? error.message : String(error)}`);
          return "failed";
        }
      });
      if (outcome === "back") brought += 1; else failed += 1;
    }
    this.lastStatus = null;
    const message = failed
      ? `Brought back ${brought} chat(s); ${failed} could not come back yet and are still safe in Cloud storage. Run this again to retry them.`
      : `Brought back every chat's files (${brought}).`;
    this.log(message);
    return { ok: failed === 0, brought, failed, message };
  }
}
