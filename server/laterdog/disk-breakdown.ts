import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../atomic.ts";
import { BUILD_OUTPUT_DIRS } from "./janitor.ts";
import type { WalkJob, WalkResult, WalkRoot } from "./disk-walk.ts";

export interface BreakdownEntry {
  area: string;
  label: string;
  bytes: number;
  atLeast?: true;
  within?: string;
  dogId?: string;
  dogName?: string;
}

export interface DiskBreakdown {
  at: number;
  tookMs: number;
  complete: boolean;
  entries: BreakdownEntry[];
}

export interface BreakdownLimits {
  rootMs: number;
  totalMs: number;
  pauseEvery: number;
  pauseMs: number;
  graceMs: number;
}

export interface BreakdownDeps {
  dataDir: string;
  home: string | null;
  scratch: readonly string[];
  dogName(id: string): string | null;
  resultFile?: string;
  limits?: Partial<BreakdownLimits>;
  walker?: (job: WalkJob) => ChildProcess;
  now?: () => number;
  log?: (line: string) => void;
}

export const BREAKDOWN_FILE = "disk-breakdown.json";
export const DEFAULT_LIMITS: BreakdownLimits = { rootMs: 2 * 60_000, totalMs: 10 * 60_000, pauseEvery: 2000, pauseMs: 2, graceMs: 15_000 };
export const TOP_DOGS = 10;
const SAFE_NAME = /^\.?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DOG_ID = /^[A-Za-z0-9_-]{1,128}$/;
const WORKSPACES = "task-workspaces";
const PNPM_STORE = ".local/share/pnpm";

type Area = readonly [area: string, label: string];

const DATA_AREAS: Readonly<Record<string, Area>> = {
  workspaces: ["dog-folders", "Dogs' own folders"],
  attachments: ["attachments", "Files shared in chats"],
  events: ["conversation-logs", "Conversation logs"],
  native: ["conversation-logs", "Conversation logs"],
  "tool-results": ["tool-results", "Saved tool results"],
  providers: ["engine-sessions", "Saved engine sessions"],
  checkpoints: ["checkpoints", "Saved checkpoints"],
  "vm-home": ["computer-folders", "Computer home folders"],
  "vm-homes": ["computer-folders", "Computer home folders"],
  "chrome-profile": ["browser", "Web browser data"],
  skills: ["skills", "Skills"],
  "skill-state": ["skills", "Skills"],
};

const HOME_AREAS: Readonly<Record<string, Area>> = {
  ".claude": ["engine-sessions", "Saved engine sessions"],
  ".codex": ["engine-sessions", "Saved engine sessions"],
  ".grok": ["engine-sessions", "Saved engine sessions"],
  ".cursor": ["engine-sessions", "Saved engine sessions"],
  ".kimi-code": ["engine-sessions", "Saved engine sessions"],
  ".pi": ["engine-sessions", "Saved engine sessions"],
  ".gemini": ["engine-sessions", "Saved engine sessions"],
  ".npm": ["packages", "Downloaded packages"],
  ".pnpm-store": ["packages", "Downloaded packages"],
  ".yarn": ["packages", "Downloaded packages"],
  ".bun": ["packages", "Downloaded packages"],
  ".cache": ["caches", "Program caches"],
  ".local": ["programs", "Installed programs"],
  ".nvm": ["programs", "Installed programs"],
  ".cargo": ["programs", "Installed programs"],
  ".rustup": ["programs", "Installed programs"],
  ".pyenv": ["programs", "Installed programs"],
  ".deno": ["programs", "Installed programs"],
  go: ["programs", "Installed programs"],
  ".agent-browser": ["browser", "Web browser data"],
  Downloads: ["downloads", "Downloads"],
};

const DATABASE = /\.(?:db|sqlite3?)(?:-wal|-shm|-journal)?$/;

interface Plan {
  roots: WalkRoot[];
  labels: Map<string, Area>;
  dogs: string[];
}

const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}${sep}`);

async function entriesOf(dir: string): Promise<{ name: string; dir: boolean }[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).map((entry) => ({ name: entry.name, dir: entry.isDirectory() }));
  } catch {
    return [];
  }
}

async function deviceOf(path: string): Promise<number | null> {
  try { return (await lstat(path)).dev; } catch { return null; }
}

class PlanBuilder {
  readonly roots = new Map<string, WalkRoot>();
  readonly labels = new Map<string, Area>();
  constructor(private readonly device: number | null) {}

  async add([area, label]: Area, path: string, extra: Partial<WalkRoot> = {}): Promise<void> {
    if (this.device !== null && await deviceOf(path) !== this.device) return;
    const root = this.roots.get(area);
    if (root) {
      root.paths.push(path);
      if (extra.skip) root.skip = [...(root.skip ?? []), ...extra.skip];
      return;
    }
    this.roots.set(area, { key: area, paths: [path], ...extra });
    this.labels.set(area, [area, label]);
  }
}

export async function planBreakdown(deps: Pick<BreakdownDeps, "dataDir" | "home" | "scratch">): Promise<Plan> {
  const device = await deviceOf(deps.dataDir);
  const plan = new PlanBuilder(device);
  const home = deps.home;
  const store = home ? join(home, PNPM_STORE) : null;
  if (store && existsSync(store)) await plan.add(["packages", "Downloaded packages"], store);
  const dogs: string[] = [];
  for (const entry of await entriesOf(join(deps.dataDir, WORKSPACES))) {
    const path = join(deps.dataDir, WORKSPACES, entry.name);
    if (entry.dir && DOG_ID.test(entry.name)) {
      if (device !== null && await deviceOf(path) !== device) continue;
      dogs.push(entry.name);
      plan.roots.set(`dog:${entry.name}`, { key: `dog:${entry.name}`, paths: [path], split: true });
    } else await plan.add(["dogs-other", "Other dogs"], path, { split: true });
  }
  for (const entry of await entriesOf(deps.dataDir)) {
    if (entry.name === WORKSPACES) continue;
    const path = join(deps.dataDir, entry.name);
    const known = DATA_AREAS[entry.name];
    if (known) await plan.add(known, path);
    else if (!entry.dir) await plan.add(DATABASE.test(entry.name) ? ["database", "Databases"] : ["data-files", "Settings and small files"], path);
    else if (SAFE_NAME.test(entry.name)) await plan.add([`data:${entry.name}`, `Other home data: ${entry.name}`], path);
    else await plan.add(["data-other", "Other home data"], path);
  }
  if (home && !within(home, deps.dataDir)) {
    const skip = [deps.dataDir, ...(store ? [store] : [])];
    for (const entry of await entriesOf(home)) {
      const path = join(home, entry.name);
      if (path === deps.dataDir) continue;
      const known = HOME_AREAS[entry.name];
      const area: Area = known
        ?? (!entry.name.startsWith(".") ? ["home-projects", "Projects in the home folder"]
          : SAFE_NAME.test(entry.name) ? [`home:${entry.name}`, `Other home folder: ${entry.name}`] : ["home-other", "Other home folders"]);
      const nested = skip.filter((inner) => within(inner, path) && inner !== path);
      await plan.add(area, path, nested.length ? { skip: nested } : {});
    }
  }
  for (const path of deps.scratch) {
    if (home && within(path, home) || within(path, deps.dataDir) || within(deps.dataDir, path)) continue;
    await plan.add(["scratch", "Temporary files"], path);
  }
  return { roots: [...plan.roots.values()], labels: plan.labels, dogs };
}

function walkerScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "disk-walk.ts"), join(here, "disk-walk.js"), join(here, "laterdog", "disk-walk.js")];
  return candidates.find((path) => existsSync(path)) ?? candidates[1]!;
}

export function spawnWalker(job: WalkJob): ChildProcess {
  const child = spawn(process.execPath, [walkerScript()], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  child.stdin?.end(JSON.stringify(job));
  return child;
}

function readWalk(child: ChildProcess, killAfterMs: number): Promise<{ results: WalkResult[]; ok: boolean }> {
  return new Promise((resolve) => {
    const results: WalkResult[] = [];
    let buffered = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, killAfterMs);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      let at;
      while ((at = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        try { results.push(JSON.parse(line) as WalkResult); } catch {}
      }
    });
    const finish = (ok: boolean) => { clearTimeout(timer); resolve({ results, ok: ok && !killed }); };
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

const byBytes = (a: { bytes: number }, b: { bytes: number }) => b.bytes - a.bytes;

export function assemble(plan: Plan, results: readonly WalkResult[], dogName: (id: string) => string | null): { entries: BreakdownEntry[]; complete: boolean } {
  const found = new Map(results.map((result) => [result.key, result]));
  const flag = (atLeast: boolean | undefined) => (atLeast ? { atLeast: true as const } : {});
  const entries: BreakdownEntry[] = [];
  for (const root of plan.roots) {
    const area = plan.labels.get(root.key);
    const result = found.get(root.key);
    if (!area || !result || root.split) continue;
    entries.push({ area: area[0], label: area[1], bytes: result.bytes, ...flag(result.atLeast) });
  }
  const dogResults = plan.roots.filter((root) => root.split).map((root) => found.get(root.key)).filter((result): result is WalkResult => Boolean(result));
  const parts: BreakdownEntry[] = [];
  if (dogResults.length) {
    const sum = (pick: (result: WalkResult) => number) => dogResults.reduce((total, result) => total + pick(result), 0);
    const partial = dogResults.some((result) => result.atLeast);
    const total = sum((result) => result.bytes);
    const generated = sum((result) => result.generated ?? 0);
    const history = sum((result) => result.history ?? 0);
    entries.push({ area: "workspaces", label: "Dogs' work folders", bytes: total, ...flag(partial) });
    parts.push(
      { area: "workspaces-generated", label: "Rebuildable output", bytes: generated, within: "workspaces", ...flag(partial) },
      { area: "workspaces-history", label: "Version history", bytes: history, within: "workspaces", ...flag(partial) },
      { area: "workspaces-files", label: "Everything else", bytes: total - generated - history, within: "workspaces", ...flag(partial) },
    );
    const perDog = dogResults.filter((result) => result.key.startsWith("dog:")).sort(byBytes);
    for (const result of perDog.slice(0, TOP_DOGS)) {
      const dogId = result.key.slice(4);
      const name = dogName(dogId);
      parts.push({ area: result.key, label: name ?? "A removed dog", bytes: result.bytes, within: "workspaces", dogId, ...(name ? { dogName: name } : {}), ...flag(result.atLeast) });
    }
    const rest = [...perDog.slice(TOP_DOGS), ...dogResults.filter((result) => !result.key.startsWith("dog:"))];
    if (rest.length) {
      parts.push({ area: "dogs-other", label: "Other dogs", bytes: rest.reduce((total, result) => total + result.bytes, 0), within: "workspaces", ...flag(rest.some((result) => result.atLeast)) });
    }
  }
  const complete = plan.roots.every((root) => found.has(root.key) && !found.get(root.key)!.atLeast);
  return { entries: [...entries.sort(byBytes), ...parts], complete };
}

export function breakdownLine(breakdown: DiskBreakdown): string {
  const top = breakdown.entries.filter((entry) => !entry.within).slice(0, 5)
    .map((entry) => `${entry.label} ${entry.atLeast ? "at least " : ""}${Math.round(entry.bytes / 1024 / 1024)} MB`);
  return `[storage] measured in ${Math.round(breakdown.tookMs / 1000)} s${breakdown.complete ? "" : " (incomplete)"}: ${top.join(", ") || "nothing found"}`;
}

function isBreakdown(value: unknown): value is DiskBreakdown {
  const candidate = value as DiskBreakdown | null;
  return Boolean(candidate) && typeof candidate!.at === "number" && typeof candidate!.tookMs === "number"
    && typeof candidate!.complete === "boolean" && Array.isArray(candidate!.entries)
    && candidate!.entries.every((entry) => typeof entry?.area === "string" && typeof entry.label === "string" && typeof entry.bytes === "number");
}

export function loadBreakdown(file: string): DiskBreakdown | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isBreakdown(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface DiskBreakdownRunner {
  last(): DiskBreakdown | null;
  running(): boolean;
  measure(): boolean;
  settled(): Promise<DiskBreakdown | null>;
}

export function createDiskBreakdown(deps: BreakdownDeps): DiskBreakdownRunner {
  const file = deps.resultFile ?? join(deps.dataDir, BREAKDOWN_FILE);
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  let last = loadBreakdown(file);
  let current: Promise<DiskBreakdown | null> | null = null;

  const run = async (): Promise<DiskBreakdown | null> => {
    const started = now();
    const plan = await planBreakdown(deps);
    const job: WalkJob = {
      roots: plan.roots,
      rootLimitMs: limits.rootMs,
      totalLimitMs: limits.totalMs,
      generatedNames: [...BUILD_OUTPUT_DIRS],
      pauseEvery: limits.pauseEvery,
      pauseMs: limits.pauseMs,
    };
    const walk = await readWalk((deps.walker ?? spawnWalker)(job), limits.totalMs + limits.graceMs);
    const { entries, complete } = assemble(plan, walk.results, deps.dogName);
    const breakdown: DiskBreakdown = { at: started, tookMs: Math.max(0, now() - started), complete: complete && walk.ok, entries };
    last = breakdown;
    try { writeFileAtomic(file, `${JSON.stringify(breakdown)}\n`, { mode: 0o600 }); } catch {}
    log(breakdownLine(breakdown));
    return breakdown;
  };

  return {
    last: () => last,
    running: () => current !== null,
    measure() {
      if (current) return false;
      current = run()
        .catch((error: unknown) => {
          log(`[storage] measuring failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        })
        .finally(() => { current = null; });
      return true;
    },
    settled: () => current ?? Promise.resolve(last),
  };
}
