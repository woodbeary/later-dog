import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { chatTempDir, chatTempName, chatTempRoot, sweepChatTemps, tidyChatTemp, usedBy, type ChatTempSweep } from "./chat-temp.ts";
import { floorWatch } from "./disk-floor.ts";
import { fileLadderStore, startDiskLadder } from "./disk-ladder.ts";
import { openPaths, readHomeProcesses } from "./home-processes.ts";
import { diskUse, type WorkspaceTask } from "./janitor.ts";
import { readProcesses } from "./process-reaper.ts";
import { REPO_CACHE_ROOT, sweepUnsharedCaches } from "./shared-clones.ts";
import { pruneCaches } from "./space-maker.ts";
import { endLeftovers, LEFTOVER_MODE } from "./turn-leftovers.ts";
import { turnUpkeep } from "./turn-upkeep.ts";

export interface HomeUpkeepDeps {
  subscribe(listener: (event: { type: string; threadId: string }) => void): void;
  atWork(threadId: string): boolean;
  chats(): WorkspaceTask[];
  dataDir: string;
  home: string;
  tempRoot?: string;
  log?: (line: string) => void;
}

const mb = (bytes: number) => `${Math.round(bytes / 1024 ** 2)} MB`;

export function liveTempSweep(atWork: (threadId: string) => boolean): ChatTempSweep {
  const all = readHomeProcesses();
  return {
    atWork,
    engineAlive: (name) => all.some((proc) => proc.mark !== null && chatTempName(proc.mark) === name),
    inUse: usedBy(all.flatMap((proc) => [proc.cwd, ...openPaths(proc.pid)]), all.map((proc) => proc.argv)),
  };
}

function hasEntries(dir: string): boolean {
  try { return readdirSync(dir).length > 0; } catch { return false; }
}

export function emptyTempAfterTurn(root: string, threadId: string, sweep: () => ChatTempSweep, log: (line: string) => void): void {
  if (!hasEntries(chatTempDir(root, threadId))) return;
  const cleared = tidyChatTemp(root, chatTempName(threadId), sweep());
  if (cleared.removed.length) log(`laterdog home: chat ${threadId.slice(0, 8)} finished its turn; removed ${cleared.removed.length} temp item(s) nothing was using, freed ${mb(cleared.freed)}`);
}

export function startHomeUpkeep(deps: HomeUpkeepDeps): { warning(): string | null } {
  const log = deps.log ?? ((line: string) => console.log(line));
  const root = deps.tempRoot ?? chatTempRoot();
  const emptyTemp = (threadId: string) => emptyTempAfterTurn(root, threadId, () => liveTempSweep(deps.atWork), log);
  deps.subscribe(turnUpkeep({ atWork: deps.atWork, endLeftovers: (mark) => endLeftovers({ mark, mode: LEFTOVER_MODE }), mode: LEFTOVER_MODE, emptyTemp, log }));
  const floor = floorWatch();
  startDiskLadder({
    disk: () => diskUse(deps.dataDir),
    chats: () => deps.chats().map((chat) => ({ ...chat, busy: chat.busy || deps.atWork(basename(chat.dir)) })),
    live: () => readProcesses(),
    sweepTemp: () => {
      const temp = sweepChatTemps(root, liveTempSweep(deps.atWork));
      const caches = sweepUnsharedCaches(REPO_CACHE_ROOT());
      return { removed: [...temp.removed, ...caches.removed], freed: temp.freed + caches.freed };
    },
    pruneCaches: () => pruneCaches({ home: deps.home })?.freed ?? null,
    log,
    store: fileLadderStore(join(deps.dataDir, "disk-ladder.json")),
  }, undefined, floor.climbed);
  return { warning: () => floor.warning(diskUse(deps.dataDir)) };
}
