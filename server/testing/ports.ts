import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mcpOAuthRedirectUri } from "../mcp-oauth.ts";

export const PORT_LEASE_FLOOR = 19_600;
export const PORT_LEASE_CEILING = 32_000;
const ABANDONED_RECLAIM_MS = 60_000;

interface LeaseRegistry {
  held: Map<number, { path: string; token: string }>;
  exitHookInstalled: boolean;
}

const REGISTRY_KEY = Symbol.for("laterdog.testing.portLeases");
const registry: LeaseRegistry = ((globalThis as Record<symbol, unknown>)[REGISTRY_KEY] as LeaseRegistry | undefined)
  ?? ((globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = { held: new Map(), exitHookInstalled: false } as LeaseRegistry);
const heldByThisModule = new Set<number>();
let leaseSequence = 0;

export function portLeaseDirectory(): string {
  const configured = process.env.LATERDOG_PORT_LEASE_DIR;
  if (configured) return configured;
  if (process.platform === "win32") return join(tmpdir(), "laterdog-port-leases");
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return `/tmp/laterdog-port-leases-${uid}`;
}

const leasePath = (port: number) => join(portLeaseDirectory(), `${port}.lease`);

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function readLease(path: string): { pid: number; token: string } | null {
  try {
    const [pid, token] = readFileSync(path, "utf8").trim().split(/\s+/);
    return { pid: Number(pid), token: token ?? "" };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function createExclusively(path: string, token: string): boolean {
  const draft = `${path}.${process.pid}.${token}.draft`;
  writeFileSync(draft, `${process.pid} ${token}\n`, { mode: 0o600 });
  try {
    linkSync(draft, path);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(draft);
  }
}

function removeIfStillHeldBy(path: string, holder: { pid: number; token: string }): void {
  const current = readLease(path);
  if (current && current.pid === holder.pid && current.token === holder.token) {
    try { unlinkSync(path); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  }
}

function reclaimAbandoned(port: number): boolean {
  const path = leasePath(port);
  const seen = readLease(path);
  if (!seen) return true;
  if (processIsAlive(seen.pid)) return false;
  const guard = `${path}.reclaim`;
  const token = nextToken();
  if (!createExclusively(guard, token)) {
    const holder = readLease(guard);
    if (holder && !processIsAlive(holder.pid) && Date.now() - modifiedAt(guard) > ABANDONED_RECLAIM_MS) removeIfStillHeldBy(guard, holder);
    return false;
  }
  try {
    const current = readLease(path);
    if (current && !processIsAlive(current.pid)) removeIfStillHeldBy(path, current);
    return true;
  } finally {
    removeIfStillHeldBy(guard, { pid: process.pid, token });
  }
}

function modifiedAt(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return Date.now(); }
}

function nextToken(): string {
  leaseSequence += 1;
  return `${Date.now().toString(36)}-${leaseSequence}-${Math.random().toString(36).slice(2, 10)}`;
}

function installExitHook(): void {
  if (registry.exitHookInstalled) return;
  registry.exitHookInstalled = true;
  process.once("exit", () => {
    for (const { path, token } of registry.held.values()) {
      try { removeIfStillHeldBy(path, { pid: process.pid, token }); } catch {}
    }
    registry.held.clear();
  });
}

function acquire(port: number): boolean {
  if (registry.held.has(port)) return false;
  const path = leasePath(port);
  const token = nextToken();
  if (!createExclusively(path, token)) {
    if (!reclaimAbandoned(port) || !createExclusively(path, token)) return false;
  }
  registry.held.set(port, { path, token });
  heldByThisModule.add(port);
  installExitHook();
  return true;
}

function release(port: number): void {
  const lease = registry.held.get(port);
  heldByThisModule.delete(port);
  if (lease === undefined) return;
  registry.held.delete(port);
  removeIfStillHeldBy(lease.path, { pid: process.pid, token: lease.token });
}

const isFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

function ephemeralFloor(): number {
  try {
    return Number(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0]) || 49_152;
  } catch {
    return 49_152;
  }
}

async function leaseAll(ports: number[]): Promise<boolean> {
  const taken: number[] = [];
  for (const port of ports) {
    if (!acquire(port)) break;
    taken.push(port);
  }
  if (taken.length === ports.length && (await Promise.all(ports.map(isFree))).every(Boolean)) return true;
  for (const port of taken) release(port);
  return false;
}

export async function tryLeasePorts(ports: number[]): Promise<boolean> {
  mkdirSync(portLeaseDirectory(), { recursive: true, mode: 0o700 });
  return leaseAll(ports);
}

export async function leasePortBlock(offsets: number[]): Promise<number> {
  if (offsets.length === 0 || offsets.some((offset) => !Number.isInteger(offset) || offset < 0)) {
    throw new Error(`port offsets must be non-negative integers, got ${offsets.join(",")}`);
  }
  mkdirSync(portLeaseDirectory(), { recursive: true, mode: 0o700 });
  const ceiling = Math.min(PORT_LEASE_CEILING, ephemeralFloor()) - Math.max(...offsets);
  const span = ceiling - PORT_LEASE_FLOOR;
  for (let attempt = 0; attempt < 200; attempt++) {
    const base = PORT_LEASE_FLOOR + Math.floor(Math.random() * span);
    if (await leaseAll(offsets.map((offset) => base + offset))) return base;
  }
  throw new Error(`no free port block for offsets ${offsets.join(",")} in ${PORT_LEASE_FLOOR}..${ceiling} (leases in ${portLeaseDirectory()})`);
}

export function leasePort(): Promise<number> {
  return leasePortBlock([0]);
}

export function releasePortLeases(ports?: Iterable<number>): void {
  for (const port of ports ?? heldByThisModule) release(port);
}

export async function withFreeSignInPort(url: string): Promise<string> {
  const floor = ephemeralFloor();
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = new URL(url);
    candidate.searchParams.set("app", String(attempt));
    const port = Number(new URL(mcpOAuthRedirectUri(candidate.toString())).port);
    if (port < floor && await tryLeasePorts([port])) return candidate.toString();
  }
  throw new Error(`no free sign-in redirect port below ${floor} for ${url}`);
}
