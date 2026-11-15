import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, isAbsolute, relative, sep } from "node:path";
import { SERVER_ROOT } from "../proxy-paths.ts";

const HOUR_MS = 60 * 60 * 1000;
export const IDLE_ORPHAN_HOURS = 6;
export const REAP_GRACE_MS = 5_000;
export const PRESSURE_ORPHAN_MINUTES = 30;
export const MEMORY_CHECK_MS = 60_000;
export const PRESSURE_AVAILABLE_PERCENT = 15;
export const PRESSURE_PSI_SOME_AVG10 = 10;

export interface MemoryPressure {
  availablePercent: number | null;
  psiSomeAvg10: number | null;
}

export function readMemoryPressure(procDir = "/proc"): MemoryPressure {
  let availablePercent: number | null = null;
  let psiSomeAvg10: number | null = null;
  try {
    const info = readFileSync(`${procDir}/meminfo`, "utf8");
    const total = Number(/^MemTotal:\s+(\d+)/m.exec(info)?.[1]);
    const available = Number(/^MemAvailable:\s+(\d+)/m.exec(info)?.[1]);
    if (total > 0 && Number.isFinite(available)) availablePercent = (available / total) * 100;
  } catch {}
  try {
    const psi = readFileSync(`${procDir}/pressure/memory`, "utf8");
    const avg10 = Number(/^some avg10=([\d.]+)/m.exec(psi)?.[1]);
    if (Number.isFinite(avg10)) psiSomeAvg10 = avg10;
  } catch {}
  return { availablePercent, psiSomeAvg10 };
}

export function underMemoryPressure(pressure: MemoryPressure): boolean {
  return (pressure.availablePercent !== null && pressure.availablePercent < PRESSURE_AVAILABLE_PERCENT)
    || (pressure.psiSomeAvg10 !== null && pressure.psiSomeAvg10 > PRESSURE_PSI_SOME_AVG10);
}

export function orphanIdleHours(pressure: MemoryPressure): number {
  return underMemoryPressure(pressure) ? PRESSURE_ORPHAN_MINUTES / 60 : IDLE_ORPHAN_HOURS;
}

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

const ENGINE_PROGRAMS: ReadonlySet<string> = new Set(["claude", "codex", "opencode", "cursor-agent", "grok", "cloudchamber"]);
const SCRIPT_RUNNERS: ReadonlySet<string> = new Set(["node", "nodejs", "bun", "tsx"]);
const RUNNER_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--conditions", "-C", "--title", "--input-type"]);
const PUSHED_SERVER = /(?:^|\/)laterdog-dev-server\//;

export function programOf(argv: string): string {
  const words = argv.trim().split(/\s+/);
  const executable = words[0] ?? "";
  if (!SCRIPT_RUNNERS.has(basename(executable))) return executable;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (RUNNER_FLAGS_WITH_VALUE.has(word)) index += 1;
    else if (!word.startsWith("-")) return word;
  }
  return executable;
}

export function isEngineProcess(argv: string, serverRoot = SERVER_ROOT): boolean {
  const program = programOf(argv);
  if (ENGINE_PROGRAMS.has(basename(program).replace(/\.(?:exe|[cm]?js|ts)$/, ""))) return true;
  if (!isAbsolute(program)) return false;
  const inside = relative(serverRoot, program);
  return PUSHED_SERVER.test(program) || program.includes("/cloudchamber/") || (inside !== "" && !inside.startsWith("..") && !isAbsolute(inside));
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
  orphanIdleHours?: number;
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
    const reason = reapReason(proc, deps.thread(owner.botId, owner.threadId), now, deps.orphanIdleHours);
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
