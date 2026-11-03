import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { relative, sep } from "node:path";

const HOUR_MS = 60 * 60 * 1000;
export const IDLE_ORPHAN_HOURS = 6;
export const REAP_GRACE_MS = 5_000;

export interface ProcessInfo {
  pid: number;
  ppid: number;
  cwd: string;
  argv: string;
}

export interface ThreadState {
  exists: boolean;
  busy: boolean;
  closed: boolean;
  lastActiveAt: number | null;
}

const ENGINE = /(?:^|[\s/])(?:claude|codex|opencode|cursor-agent|grok)(?:\s|$)|harness-mcp-proxy|mcp-gate|permission-proxy|agents-proxy|mcp\.js|laterdog-dev-server|\/laterdog\/|cloudchamber/;

export function isEngineProcess(argv: string): boolean {
  return ENGINE.test(argv);
}

export function workspaceThread(cwd: string, roots: readonly string[]): { botId: string; threadId: string } | null {
  for (const root of roots) {
    const inside = relative(root, cwd);
    if (!inside || inside.startsWith("..") || inside.startsWith(sep)) continue;
    const [botId, threadId] = inside.split(sep);
    if (botId && threadId) return { botId, threadId };
  }
  return null;
}

export type ReapReason = "task closed" | "task gone" | "orphan of an idle task";

export function reapReason(proc: ProcessInfo, thread: ThreadState, now = Date.now(), idleHours = IDLE_ORPHAN_HOURS): ReapReason | null {
  if (isEngineProcess(proc.argv)) return null;
  if (!thread.exists) return "task gone";
  if (thread.busy) return null;
  if (thread.closed) return "task closed";
  if (proc.ppid !== 1) return null;
  return thread.lastActiveAt !== null && thread.lastActiveAt < now - idleHours * HOUR_MS ? "orphan of an idle task" : null;
}

export function readProcesses(procDir = "/proc"): ProcessInfo[] {
  const found: ProcessInfo[] = [];
  let names: string[] = [];
  try { names = readdirSync(procDir); } catch { return found; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`${procDir}/${name}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const cwd = readlinkSync(`${procDir}/${name}/cwd`);
      const argv = readFileSync(`${procDir}/${name}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      found.push({ pid: Number(name), ppid, cwd, argv });
    } catch {}
  }
  return found;
}

export function withDescendants(roots: readonly number[], all: readonly ProcessInfo[]): number[] {
  const children = new Map<number, number[]>();
  for (const proc of all) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc.pid]);
  const seen = new Set<number>();
  const visit = (pid: number) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) visit(child);
  };
  roots.forEach(visit);
  return [...seen];
}

export interface ReapDeps {
  roots: readonly string[];
  thread(botId: string, threadId: string): ThreadState;
  processes?: () => ProcessInfo[];
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  later?: (run: () => void, ms: number) => void;
  self?: number;
  now?: () => number;
}

export function reapStrays(deps: ReapDeps): { pid: number; argv: string; reason: ReapReason }[] {
  const all = (deps.processes ?? readProcesses)();
  const self = deps.self ?? process.pid;
  const now = deps.now?.() ?? Date.now();
  const chosen: { pid: number; argv: string; reason: ReapReason }[] = [];
  for (const proc of all) {
    if (proc.pid === self || proc.pid === 1) continue;
    const owner = workspaceThread(proc.cwd, deps.roots);
    if (!owner) continue;
    const reason = reapReason(proc, deps.thread(owner.botId, owner.threadId), now);
    if (reason) chosen.push({ pid: proc.pid, argv: proc.argv, reason });
  }
  const targets = withDescendants(chosen.map((proc) => proc.pid), all)
    .filter((pid) => pid !== self && pid !== 1)
    .filter((pid) => !isEngineProcess(all.find((proc) => proc.pid === pid)?.argv ?? ""));
  const signal = deps.signal ?? ((pid, sig) => { try { process.kill(pid, sig); } catch {} });
  for (const pid of targets) signal(pid, "SIGTERM");
  if (targets.length) (deps.later ?? ((run, ms) => setTimeout(run, ms).unref()))(() => targets.forEach((pid) => signal(pid, "SIGKILL")), REAP_GRACE_MS);
  return chosen;
}
