import { readFileSync, readdirSync } from "node:fs";

export interface ProcReader {
  pids(): string[];
  stat(pid: string): string | null;
}

export interface ProcStat {
  pid: number;
  state: string;
  group: number;
}

const DEAD_STATES = new Set(["Z", "X", "x"]);

export const linuxProc: ProcReader = {
  pids: () => readdirSync("/proc").filter((name) => /^\d+$/.test(name)),
  stat: (pid) => {
    try {
      return readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return null;
    }
  },
};

export function parseProcStat(text: string): ProcStat | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 1 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const [state, , group] = text.slice(close + 1).trim().split(/\s+/);
  const groupId = Number(group);
  if (!Number.isInteger(pid) || pid <= 0 || !state || !Number.isInteger(groupId)) return null;
  return { pid, state, group: groupId };
}

export function processGroupHoldsOnlyZombies(
  groupId: number,
  options: { platform?: NodeJS.Platform; reader?: ProcReader; self?: number } = {},
): boolean {
  if ((options.platform ?? process.platform) !== "linux") return false;
  if (!Number.isInteger(groupId) || groupId <= 1) return false;
  const reader = options.reader ?? linuxProc;
  const self = options.self ?? process.pid;
  let pids: string[];
  try {
    pids = reader.pids();
  } catch {
    return false;
  }
  if (!pids.includes(String(self))) return false;
  for (const pid of pids) {
    const text = reader.stat(pid);
    if (text === null) continue;
    const stat = parseProcStat(text);
    if (!stat) return false;
    if (stat.group === groupId && !DEAD_STATES.has(stat.state)) return false;
  }
  return true;
}
