import { readdirSync, readFileSync, readlinkSync } from "node:fs";

export const CHAT_MARK = "LATERDOG_CHAT";

export interface HomeProcess {
  pid: number;
  ppid: number;
  started: number;
  argv: string;
  cwd: string;
  mark: string | null;
}

export function markIn(environ: string): string | null {
  for (const entry of environ.split("\0")) {
    if (entry.startsWith(`${CHAT_MARK}=`)) return entry.slice(CHAT_MARK.length + 1) || null;
  }
  return null;
}

function statFields(stat: string): { ppid: number; started: number } {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { ppid: Number(fields[1]), started: Number(fields[19]) };
}

export function readHomeProcess(pid: number, procDir = "/proc"): HomeProcess | null {
  try {
    const { ppid, started } = statFields(readFileSync(`${procDir}/${pid}/stat`, "utf8"));
    let cwd = "";
    try { cwd = readlinkSync(`${procDir}/${pid}/cwd`); } catch {}
    let mark: string | null = null;
    try { mark = markIn(readFileSync(`${procDir}/${pid}/environ`, "utf8")); } catch {}
    const argv = readFileSync(`${procDir}/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    return { pid, ppid, started, argv, cwd, mark };
  } catch {
    return null;
  }
}

export function readHomeProcesses(procDir = "/proc"): HomeProcess[] {
  let names: string[] = [];
  try { names = readdirSync(procDir); } catch { return []; }
  return names.filter((name) => /^\d+$/.test(name)).flatMap((name) => readHomeProcess(Number(name), procDir) ?? []);
}

export function openPaths(pid: number, procDir = "/proc"): string[] {
  let fds: string[] = [];
  try { fds = readdirSync(`${procDir}/${pid}/fd`); } catch { return []; }
  return fds.flatMap((fd) => {
    try { return [readlinkSync(`${procDir}/${pid}/fd/${fd}`)]; } catch { return []; }
  });
}

export function homeAncestors(self: number, all: readonly Pick<HomeProcess, "pid" | "ppid">[]): Set<number> {
  const byPid = new Map(all.map((proc) => [proc.pid, proc]));
  const kept = new Set<number>([1, self]);
  for (let current = byPid.get(self); current && current.ppid > 0 && !kept.has(current.ppid); current = byPid.get(current.ppid)) kept.add(current.ppid);
  return kept;
}
