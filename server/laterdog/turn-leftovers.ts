import { homeAncestors, readHomeProcess, readHomeProcesses, type HomeProcess } from "./home-processes.ts";
import { isEngineProcess, REAP_GRACE_MS, withDescendants } from "./process-reaper.ts";

export function leftoverRoots(mark: string, all: readonly HomeProcess[], self: number): HomeProcess[] {
  const kept = homeAncestors(self, all);
  const byPid = new Map(all.map((proc) => [proc.pid, proc]));
  return all.filter((proc) => proc.mark === mark
    && !kept.has(proc.pid)
    && proc.ppid !== self
    && !isEngineProcess(proc.argv)
    && byPid.get(proc.ppid)?.mark !== mark);
}

export type LeftoverMode = "observe" | "act";

export const LEFTOVER_MODE: LeftoverMode = "observe";

export interface LeftoverDeps {
  mark: string;
  mode?: LeftoverMode;
  processes?: () => HomeProcess[];
  reread?: (pid: number) => HomeProcess | null;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  later?: (run: () => void, ms: number) => void;
  self?: number;
}

export function endLeftovers(deps: LeftoverDeps): HomeProcess[] {
  const all = (deps.processes ?? readHomeProcesses)();
  const self = deps.self ?? process.pid;
  const roots = leftoverRoots(deps.mark, all, self);
  if (!roots.length) return [];
  const kept = homeAncestors(self, all);
  const byPid = new Map(all.map((proc) => [proc.pid, proc]));
  const targets = withDescendants(roots.map((proc) => proc.pid), all)
    .map((pid) => byPid.get(pid)!)
    .filter((proc) => !kept.has(proc.pid) && proc.pid !== self && (proc.mark === deps.mark || proc.mark === null) && !isEngineProcess(proc.argv));
  if ((deps.mode ?? LEFTOVER_MODE) === "observe") return targets;
  const signal = deps.signal ?? ((pid, sig) => { try { process.kill(pid, sig); } catch {} });
  const reread = deps.reread ?? ((pid) => readHomeProcess(pid));
  for (const proc of targets) signal(proc.pid, "SIGTERM");
  (deps.later ?? ((run, ms) => setTimeout(run, ms).unref()))(() => {
    for (const proc of targets) {
      const now = reread(proc.pid);
      if (now && now.started === proc.started && now.mark === proc.mark) signal(proc.pid, "SIGKILL");
    }
  }, REAP_GRACE_MS);
  return targets;
}

const LINE_LIMIT = 10;

function program(argv: string): string {
  const first = argv.trim().split(/\s+/)[0] ?? "";
  return first.slice(first.lastIndexOf("/") + 1) || "?";
}

export function leftoversLine(chat: string, ended: readonly HomeProcess[], mode: LeftoverMode = LEFTOVER_MODE): string {
  const named = ended.slice(0, LINE_LIMIT).map((proc) => `${proc.pid} ${program(proc.argv)}`).join(", ");
  const more = ended.length > LINE_LIMIT ? ` and ${ended.length - LINE_LIMIT} more` : "";
  return `laterdog home: chat ${chat.slice(0, 8)} finished its turn; ${mode === "act" ? "stopped" : "would stop"} ${ended.length} process(es) it left running: ${named}${more}`;
}
