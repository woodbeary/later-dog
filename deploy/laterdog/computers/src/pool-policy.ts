import type { Refusal } from "./auth";
import { bounded } from "./idle";

export const MINUTE = 60_000;
export const POOL_INSTANCE = "standard-3";
export const POOL_MEMORY_GIB = 8;
export const POOL_DISK_GB = 16;
export const POOL_VCPUS = 2;
const MEMORY_GIB_SECOND_USD = 0.0000025;
const DISK_GB_SECOND_USD = 0.00000007;
const VCPU_SECOND_USD = 0.00002;
export const AGENT_PORT = 7171;
export const CHECK_MS = 30_000;
export const START_PATIENCE_MS = 90_000;
export const ENGINES_PER_HOST = 12;
export const HEADROOM_ENGINES = 8;

export type HostState = "starting" | "ready" | "draining";

export interface HostLoad {
  limitBytes: number;
  usedBytes: number;
  budgetBytes: number;
  estimateBytes: number;
  engines: number;
  busy: number;
  warm: string[];
  cpuShare?: number;
}

export interface PoolHostRecord {
  id: string;
  state: HostState;
  startedAt: number;
  readyAt?: number;
  checkedAt?: number;
  load?: HostLoad;
  highSince?: number;
  lowSince?: number;
}

export interface PoolSettings {
  minHosts: number;
  maxHosts: number;
  scaleOutPercent: number;
  scaleOutAfterMs: number;
  scaleInPercent: number;
  scaleInAfterMs: number;
}

export interface Placement {
  host?: string;
  sticky: boolean;
  scaleOut: boolean;
}

export interface ScalePlan {
  add: number;
  drain: string[];
  remove: string[];
}

export function poolSettings(env: { POOL_HOSTS_MAX?: string }): PoolSettings {
  return {
    minHosts: 1,
    maxHosts: bounded(env.POOL_HOSTS_MAX, 4, 1, 20),
    scaleOutPercent: 80,
    scaleOutAfterMs: 2 * MINUTE,
    scaleInPercent: 30,
    scaleInAfterMs: 15 * MINUTE,
  };
}

export function usedPercent(load: HostLoad | undefined): number {
  if (!load || load.limitBytes <= 0) return 0;
  return (load.usedBytes / load.limitBytes) * 100;
}

export function roomFor(load: HostLoad | undefined): number {
  if (!load) return 0;
  return load.budgetBytes - load.usedBytes;
}

function byRoom(a: PoolHostRecord, b: PoolHostRecord): number {
  return roomFor(b.load) - roomFor(a.load) || a.startedAt - b.startedAt || a.id.localeCompare(b.id);
}

export function place(hosts: PoolHostRecord[], chat: string, stickyHost: string | undefined, skip: ReadonlySet<string> = new Set()): Placement {
  const sticky = stickyHost ? hosts.find((host) => host.id === stickyHost && host.state !== "starting" && !skip.has(host.id)) : undefined;
  if (sticky && sticky.load?.warm.includes(chat)) return { host: sticky.id, sticky: true, scaleOut: false };
  const ready = hosts.filter((host) => host.state === "ready" && !skip.has(host.id) && host.load).sort(byRoom);
  const fits = ready.find((host) => host.load!.engines < ENGINES_PER_HOST && roomFor(host.load) >= host.load!.estimateBytes);
  if (fits) return { host: fits.id, sticky: false, scaleOut: false };
  const evictable = ready.find((host) => host.load!.engines > host.load!.busy);
  if (evictable) return { host: evictable.id, sticky: false, scaleOut: true };
  return { sticky: false, scaleOut: true };
}

export function observe(host: PoolHostRecord, load: HostLoad, now: number, settings: PoolSettings): PoolHostRecord {
  const percent = usedPercent(load);
  const next: PoolHostRecord = { ...host, load, checkedAt: now };
  if (host.state === "starting") {
    next.state = "ready";
    next.readyAt = now;
  }
  if (percent > settings.scaleOutPercent) next.highSince = host.highSince ?? now;
  else delete next.highSince;
  if (percent < settings.scaleInPercent) next.lowSince = host.lowSince ?? now;
  else delete next.lowSince;
  return next;
}

export function nearlyFull(ready: PoolHostRecord[]): boolean {
  return ready.length > 0 && ready.every((host) => (host.load?.engines ?? 0) >= HEADROOM_ENGINES);
}

export function planScale(hosts: PoolHostRecord[], now: number, settings: PoolSettings): ScalePlan {
  const plan: ScalePlan = { add: 0, drain: [], remove: [] };
  const live = hosts.filter((host) => host.state !== "draining");
  const ready = live.filter((host) => host.state === "ready");
  const starting = live.filter((host) => host.state === "starting");
  if (live.length < settings.minHosts) plan.add = settings.minHosts - live.length;
  const allHigh = ready.length > 0 && ready.every((host) => host.highSince !== undefined && now - host.highSince >= settings.scaleOutAfterMs);
  if ((allHigh || nearlyFull(ready)) && starting.length === 0 && live.length + plan.add < settings.maxHosts) plan.add += 1;
  for (const host of hosts) {
    if (host.state === "draining" && (host.load?.busy ?? 0) === 0) plan.remove.push(host.id);
  }
  if (plan.add === 0 && starting.length === 0) {
    const low = ready
      .filter((host) => host.lowSince !== undefined && now - host.lowSince >= settings.scaleInAfterMs)
      .sort((a, b) => (a.load?.engines ?? 0) - (b.load?.engines ?? 0) || b.startedAt - a.startedAt);
    const room = ready.length - settings.minHosts;
    plan.drain = low.slice(0, Math.max(0, Math.min(room, 1))).map((host) => host.id);
  }
  return plan;
}

export interface EngineSpec {
  chat: string;
  command: string[];
  env?: Record<string, string>;
}

export const ENGINE_ROOT = "/home/dog/.laterdog-engine/cli/";
const CHAT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,95}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export type Parsed<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

const bad = (code: string, message: string): Parsed<never> => ({ ok: false, refusal: { status: 400, code, message } });

export function validChat(chat: string): boolean {
  return CHAT.test(chat);
}

export function parseEngineSpec(body: unknown): Parsed<EngineSpec> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("invalid_body", "The body must be a JSON object.");
  const input = body as Record<string, unknown>;
  if (typeof input.chat !== "string" || !validChat(input.chat)) return bad("invalid_chat", "chat must be 1 to 96 letters, digits, dots, dashes or underscores.");
  const command = input.command;
  if (!Array.isArray(command) || command.length === 0 || command.length > 64 || !command.every((part) => typeof part === "string" && part.length <= 16_384)) {
    return bad("invalid_command", "command must be a list of 1 to 64 strings.");
  }
  const program = command[0] as string;
  if (!program.startsWith(ENGINE_ROOT) || program.split("/").some((part) => part === ".." || part === ".")) {
    return bad("invalid_command", `command must start an engine installed under ${ENGINE_ROOT}.`);
  }
  let env: Record<string, string> | undefined;
  if (input.env !== undefined && input.env !== null) {
    if (typeof input.env !== "object" || Array.isArray(input.env)) return bad("invalid_env", "env must map names to strings.");
    const entries = Object.entries(input.env as Record<string, unknown>);
    if (entries.length > 64 || !entries.every(([name, value]) => ENV_NAME.test(name) && typeof value === "string")) {
      return bad("invalid_env", "env takes at most 64 upper-case names with string values.");
    }
    env = Object.fromEntries(entries) as Record<string, string>;
  }
  return { ok: true, value: { chat: input.chat, command: command as string[], ...(env ? { env } : {}) } };
}

export function hostHourlyUsd(cpuShare: number): number {
  const share = Math.min(1, Math.max(0, cpuShare));
  return 3600 * (POOL_MEMORY_GIB * MEMORY_GIB_SECOND_USD + POOL_DISK_GB * DISK_GB_SECOND_USD + POOL_VCPUS * share * VCPU_SECOND_USD);
}

export function hourlyCost(hosts: PoolHostRecord[]): number {
  return Math.round(hosts.reduce((sum, host) => sum + hostHourlyUsd(host.load?.cpuShare ?? 0), 0) * 1000) / 1000;
}
