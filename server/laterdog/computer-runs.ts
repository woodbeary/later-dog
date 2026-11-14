import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { BUILD_OUTPUT_DIRS, isGeneratedPath } from "./janitor.ts";

export const PART_BYTES = 12 * 1024 * 1024;
export const MAX_SEND_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_BRING_BACK_BYTES = 512 * 1024 * 1024;
export const WAIT_IN_ONE_CALL_MS = 4 * 60_000;
export const MAX_RUN_MS = 2 * 60 * 60_000;
export const POLL_MS = 10_000;
export const OUTPUT_TAIL_CHARS = 12_000;
const EXEC_MS = 110_000;
const POLL_EXEC_MS = 30_000;
const LEAST_POLL_EXEC_MS = 5_000;
const NEVER_SENT: ReadonlySet<string> = new Set([".pnpm-store", ".npm"]);
const SKIPPED_NAMES: ReadonlySet<string> = new Set([...BUILD_OUTPUT_DIRS, ...NEVER_SENT, "dist", "build", "out", "coverage", "test-results", "playwright-report"]);

export const RUN_MARKER = "LATERDOG_RUN_ID";

export type RunStop = "gone" | "partial" | "alive";
export type RunLiveness = "exited" | "alive" | "dead" | "unsure";

function groupOf(id: string): string {
  return `pg=$(cat runs/.logs/${id}.pgid 2>/dev/null | tr -cd 0-9); if [ -n "$pg" ] && { [ "$pg" -le 1 ] || [ "$pg" = "$(ps -o pgid= -p $$ | tr -cd 0-9)" ]; }; then pg=; fi;`;
}

function survivorsOf(id: string): string {
  const lock = `"$HOME/runs/.logs/${id}.lock"`;
  return `{ if [ -d /proc/self/fd ]; then for p in /proc/[0-9]*; do q=\${p#/proc/}; [ "$q" = "$$" ] && continue; `
    + `if tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qx '${RUN_MARKER}=${id}'; then echo "$q"; continue; fi; `
    + `for f in "$p"/fd/*; do [ "$(readlink "$f" 2>/dev/null)" = ${lock} ] && { echo "$q"; break; }; done; done; `
    + `elif command -v lsof > /dev/null; then lsof -t ${lock} 2>/dev/null; else echo unsure; fi; } | sort -u | tr '\\n' ' ' | sed 's/ *$//'`;
}

export interface BoxExec {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface RunBox {
  exec(command: string, timeoutMs: number): Promise<BoxExec>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string): Promise<Buffer>;
}

export interface FileStamp {
  size: number;
  mtimeMs: number;
}

export type FolderStamps = Record<string, FileStamp>;

export interface RunRecord {
  id: string;
  botId: string;
  key: string;
  folder: string;
  subdir: string;
  command: string;
  startedAt: number;
  sent: FolderStamps;
  reusedSetup?: boolean;
}

export interface RunOutcome {
  id: string;
  state: "finished" | "running" | "failed";
  exitCode: number | null;
  output: string;
  broughtBack: string[];
  skipped: string[];
  sentFiles: number;
  sentBytes: number;
  note?: string;
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function runKey(folder: string): string {
  return createHash("sha256").update(folder).digest("hex").slice(0, 16);
}

export const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "npm-shrinkwrap.json"] as const;

export function setupKey(dir: string): string | null {
  const hash = createHash("sha256");
  let found = false;
  for (const name of LOCKFILES) {
    let bytes: Buffer;
    try {
      const entry = lstatSync(join(dir, name));
      if (!entry.isFile()) continue;
      bytes = readFileSync(join(dir, name));
    } catch { continue; }
    hash.update(`${name}\0${bytes.length}\0`).update(bytes);
    found = true;
  }
  return found ? hash.digest("hex").slice(0, 24) : null;
}

function safeTransferPath(path: string): boolean {
  return Boolean(path) && !path.startsWith("/") && !path.includes("\\") && !Array.from(path).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && !path.split("/").some(part => part === ".." || part === "." || !part);
}

function sendablePath(path: string): boolean {
  return safeTransferPath(path) && !isGeneratedPath(path) && !path.split("/").some(part => NEVER_SENT.has(part));
}

export function stampFolder(folder: string): FolderStamps {
  const stamps: FolderStamps = {};
  const walk = (at: string) => {
    let names: string[] = [];
    try { names = readdirSync(at); } catch { return; }
    for (const name of names) {
      const path = join(at, name);
      if (!sendablePath(relative(folder, path))) continue;
      let entry;
      try { entry = lstatSync(path); } catch { continue; }
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        stamps[relative(folder, path)] = { size: entry.size, mtimeMs: Math.floor(entry.mtimeMs) };
      }
    }
  };
  walk(folder);
  return stamps;
}

export function changesSince(before: FolderStamps, now: FolderStamps): { changed: string[]; removed: string[] } {
  const changed = Object.keys(now).filter(sendablePath).filter((path) => before[path]?.size !== now[path].size || before[path]?.mtimeMs !== now[path].mtimeMs).sort();
  const removed = Object.keys(before).filter(sendablePath).filter((path) => !(path in now)).sort();
  return { changed, removed };
}

export function bringBackList(listing: string, maxBytes = MAX_BRING_BACK_BYTES): { take: string[]; skipped: string[] } {
  const take: string[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const line of listing.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const size = Number(line.slice(0, tab));
    const path = line.slice(tab + 1).replace(/^\.\//, "");
    if (!safeTransferPath(path) || !Number.isSafeInteger(size) || size < 0 || isGeneratedPath(path) || path.split("/").some(part => SKIPPED_NAMES.has(part))) continue;
    if (total + size > maxBytes) { skipped.push(path); continue; }
    total += size;
    take.push(path);
  }
  return { take, skipped };
}

export function homeChangedSince(folder: string, paths: readonly string[], sent: FolderStamps): string[] {
  return paths.filter((path) => {
    let entry;
    try { entry = lstatSync(join(folder, path)); } catch { return false; }
    const before = sent[path];
    return !before || before.size !== entry.size || before.mtimeMs !== Math.floor(entry.mtimeMs);
  });
}

function tar(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`tar failed: ${err.trim() || `exit ${code}`}`)));
    child.stdin.end(input ?? Buffer.alloc(0));
  });
}

export function packFiles(folder: string, paths: readonly string[]): Promise<Buffer> {
  return tar(["-czf", "-", "-C", folder, "--null", "-T", "-"], Buffer.from(paths.map((path) => `${path}\0`).join("")));
}

export function unpackFiles(folder: string, archive: Buffer): Promise<Buffer> {
  return tar(["-xzf", "-", "-C", folder], archive);
}

export function parts(bytes: Buffer, size = PART_BYTES): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, at + size));
  return out.length ? out : [Buffer.alloc(0)];
}

function must(result: BoxExec, what: string): BoxExec {
  if (result.exitCode !== 0) throw new Error(`${what} on the cloud computer failed: ${(result.stderr || result.stdout).trim().slice(-600) || `exit ${result.exitCode}`}`);
  return result;
}

export class ComputerRuns {
  readonly #stateDir: string;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(stateDir: string, options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.#stateDir = stateDir;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  }

  #sentPath(botId: string, key: string) { return join(this.#stateDir, botId, `${key}.sent.json`); }
  #runPath(botId: string, id: string) { return join(this.#stateDir, botId, `run-${id}.json`); }

  #readJson<T>(path: string): T | null {
    try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
  }

  #writeJson(path: string, value: unknown) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  }

  async start(box: RunBox, input: { botId: string; folder: string; subdir?: string; command: string; active?: () => boolean; left?: () => number; started?: (record: RunRecord) => void }): Promise<RunRecord & { sentFiles: number; sentBytes: number }> {
    const key = runKey(input.folder);
    const id = randomUUID().slice(0, 8);
    const remote = `runs/${key}`;
    const now = stampFolder(input.folder);
    const before = this.#readJson<FolderStamps>(this.#sentPath(input.botId, key));
    const present = before ? (await box.exec(`test -d ${quote(remote)} && echo yes || echo no`, 30_000)).stdout.trim() === "yes" : false;
    const { changed, removed } = changesSince(present && before ? before : {}, now);
    const sentBytes = changed.reduce((sum, path) => sum + now[path].size, 0);
    if (sentBytes > MAX_SEND_BYTES) throw new Error(`that folder has ${Math.round(sentBytes / 1024 / 1024)} MB to send; the most is ${MAX_SEND_BYTES / 1024 / 1024} MB. Pick a smaller folder.`);
    const subdir = (input.subdir ?? "").replace(/^\/+|\/+$/g, "");
    const workDir = subdir ? `${remote}/${subdir}` : remote;
    must(await box.exec(`mkdir -p ${quote(remote)} ${quote(workDir)} runs/.in runs/.logs && rm -f runs/.in/${id}.*`, 30_000), "preparing the folder");
    if (changed.length) {
      const archive = await packFiles(input.folder, changed);
      const pieces = parts(archive);
      for (const [index, piece] of pieces.entries()) await box.write(`runs/.in/${id}.${String(index).padStart(4, "0")}`, piece);
      must(await box.exec(`cat runs/.in/${id}.* | tar -xzf - -C ${quote(remote)} && rm -f runs/.in/${id}.*`, EXEC_MS), "unpacking the files");
    }
    if (removed.length) {
      await box.write(`runs/.in/${id}.removed`, Buffer.from(removed.map((path) => `${path}\0`).join("")));
      must(await box.exec(`cd ${quote(remote)} && xargs -0 rm -f -- < ../.in/${id}.removed; rm -f ../.in/${id}.removed`, EXEC_MS), "removing deleted files");
    }
    this.#writeJson(this.#sentPath(input.botId, key), now);
    const setup = setupKey(subdir ? join(input.folder, subdir) : input.folder);
    let reusedSetup = false;
    if (setup) {
      const inner = quote(`${subdir ? `${subdir}/` : ""}node_modules`);
      const seed = `src=$(cat runs/.setup/${setup} 2>/dev/null); if printf %s "$src" | grep -Eqx '[0-9a-f]{16}' && [ "$src" != ${key} ] && [ -d "runs/$src"/${inner} ] && [ ! -e ${quote(`${workDir}/node_modules`)} ]; then cp -a "runs/$src"/${inner} ${quote(`${workDir}/node_modules`)} && echo reused; fi; true`;
      reusedSetup = (await box.exec(seed, EXEC_MS)).stdout.trim() === "reused";
    }
    const remember = setup
      ? `if [ $rc = 0 ] && [ -d "$HOME"/${quote(`${workDir}/node_modules`)} ]; then mkdir -p "$HOME/runs/.setup" && echo ${key} > "$HOME/runs/.setup/${setup}.${id}" && mv -f "$HOME/runs/.setup/${setup}.${id}" "$HOME/runs/.setup/${setup}"; fi; `
      : "";
    const script = `export ${RUN_MARKER}=${id}; exec 9> "$HOME/runs/.logs/${id}.lock"; ps -o pgid= -p $$ | tr -cd 0-9 > "$HOME/runs/.logs/${id}.pgid"; export PATH="$HOME/.local/bin:$PATH"; command -v pnpm > /dev/null || npm install -g --prefix "$HOME/.local" pnpm > /dev/null 2>&1; cd ${quote(workDir)} && touch "$HOME/runs/.logs/${id}.start" && ( ${input.command} ) > "$HOME/runs/.logs/${id}.log" 2>&1; rc=$?; ${remember}echo $rc > "$HOME/runs/.logs/${id}.exit"`;
    if (input.active && !input.active()) throw Object.assign(new Error("the turn ended before the command started, so nothing was run"), { code: "cancelled" });
    if (input.left && input.left() <= 0) throw Object.assign(new Error("the call's time ran out before the command started, so nothing was run"), { code: "window_ended" });
    const detached = `nohup bash -lc ${quote(script)} > /dev/null 2>&1 < /dev/null &`;
    must(await box.exec(`if command -v setsid > /dev/null; then setsid ${detached} else set -m; ${detached} fi; echo started`, 30_000), "starting the command");
    const record: RunRecord = { id, botId: input.botId, key, folder: input.folder, subdir, command: input.command, startedAt: this.#now(), sent: now, ...(reusedSetup ? { reusedSetup: true } : {}) };
    this.#writeJson(this.#runPath(input.botId, id), record);
    input.started?.(record);
    return { ...record, sentFiles: changed.length, sentBytes };
  }

  record(botId: string, id: string): RunRecord | null {
    return /^[0-9a-f]{8}$/.test(id) ? this.#readJson<RunRecord>(this.#runPath(botId, id)) : null;
  }

  async poll(box: RunBox, record: RunRecord, timeoutMs = POLL_EXEC_MS): Promise<{ done: boolean; exitCode: number | null; output: string }> {
    const result = await box.exec(`cat runs/.logs/${record.id}.exit 2>/dev/null; echo '<<<'; tail -c ${OUTPUT_TAIL_CHARS} runs/.logs/${record.id}.log 2>/dev/null`, timeoutMs);
    const [head, ...rest] = result.stdout.split("<<<\n");
    const code = head.trim();
    return { done: code !== "", exitCode: code === "" ? null : Number(code), output: rest.join("<<<\n") };
  }

  async stop(box: RunBox, record: Pick<RunRecord, "id">): Promise<RunStop> {
    if (!/^[0-9a-f]{8}$/.test(record.id)) return "alive";
    const script = `${groupOf(record.id)} S() { ${survivorsOf(record.id)}; }; `
      + `if [ -n "$pg" ]; then kill -TERM -- -$pg 2>/dev/null; for i in 1 2 3 4 5; do kill -0 -- -$pg 2>/dev/null || break; sleep 1; done; kill -KILL -- -$pg 2>/dev/null; sleep 0.5; fi; `
      + `left=$(S); if [ "$left" = "unsure" ]; then if [ -n "$pg" ] && ! kill -0 -- -$pg 2>/dev/null; then echo partial; else echo alive; fi; exit 0; fi; `
      + `for round in 1 2 3; do [ -z "$left" ] && break; kill -TERM $left 2>/dev/null; sleep 1; left=$(S); [ -n "$left" ] && kill -KILL $left 2>/dev/null; sleep 0.5; left=$(S); done; `
      + `if [ -n "$pg" ] && kill -0 -- -$pg 2>/dev/null; then echo alive; elif [ -n "$left" ]; then echo alive; else echo gone; fi`;
    const said = (await box.exec(script, 30_000)).stdout.trim();
    return said === "gone" || said === "partial" ? said : "alive";
  }

  async liveness(box: RunBox, record: Pick<RunRecord, "id">): Promise<RunLiveness> {
    if (!/^[0-9a-f]{8}$/.test(record.id)) return "unsure";
    const logs = `runs/.logs/${record.id}`;
    const script = `if [ -f ${logs}.exit ]; then echo exited; exit 0; fi; ${groupOf(record.id)} `
      + `if [ -n "$pg" ] && kill -0 -- -$pg 2>/dev/null; then echo alive; exit 0; fi; left=$(${survivorsOf(record.id)}); `
      + `if [ "$left" = "unsure" ]; then [ -n "$pg" ] && echo dead || echo unsure; elif [ -n "$left" ]; then echo alive; else echo dead; fi`;
    const said = (await box.exec(script, 30_000)).stdout.trim();
    return said === "exited" || said === "alive" || said === "dead" ? said : "unsure";
  }

  window(budgetMs = WAIT_IN_ONE_CALL_MS): () => number {
    const until = this.#now() + budgetMs;
    return () => until - this.#now();
  }

  async wait(box: RunBox, record: RunRecord, left: () => number = this.window()) {
    for (;;) {
      const state = await this.poll(box, record, Math.min(POLL_EXEC_MS, Math.max(LEAST_POLL_EXEC_MS, left())));
      if (state.done || left() <= 0 || this.#now() - record.startedAt >= MAX_RUN_MS) return state;
      await this.#sleep(Math.min(POLL_MS, left()));
    }
  }

  async bringBack(box: RunBox, record: RunRecord): Promise<{ broughtBack: string[]; skipped: string[]; conflicts: string[] }> {
    const remote = `runs/${record.key}`;
    const lister = `import os,sys\nskip=set(sys.argv[2].split(","))\nsince=os.stat(sys.argv[1]).st_mtime\nfor root,dirs,files in os.walk("."):\n  dirs[:]=[d for d in dirs if d not in skip]\n  for f in files:\n    p=os.path.join(root,f)\n    try: st=os.lstat(p)\n    except OSError: continue\n    if st.st_mtime>=since: print(f"{st.st_size}\\t{p}")\n`;
    const listing = must(await box.exec(`cd ${quote(remote)} && python3 -c ${quote(lister)} ../.logs/${record.id}.start ${quote([...SKIPPED_NAMES].join(","))}`, EXEC_MS), "listing changed files");
    const { take, skipped } = bringBackList(listing.stdout);
    const conflicts = homeChangedSince(record.folder, take, record.sent);
    const fetch = take.filter((path) => !conflicts.includes(path));
    if (!fetch.length) return { broughtBack: [], skipped, conflicts };
    await box.write(`runs/.in/${record.id}.back`, Buffer.from(fetch.map((path) => `${path}\0`).join("")));
    const packed = must(await box.exec(`cd ${quote(remote)} && tar -czf - --null -T ../.in/${record.id}.back | split -b ${PART_BYTES} -a 4 - ../.in/${record.id}.out. && ls ../.in/ | grep '^${record.id}\\.out\\.' | sort`, EXEC_MS), "packing the results");
    const pieces: Buffer[] = [];
    for (const name of packed.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) pieces.push(await box.read(`runs/.in/${name}`));
    await box.exec(`rm -f runs/.in/${record.id}.*`, 30_000).catch(() => null);
    await unpackFiles(record.folder, Buffer.concat(pieces));
    const sent = { ...Object.fromEntries(Object.entries(record.sent).filter(([path]) => sendablePath(path))), ...stampFolder(record.folder) };
    this.#writeJson(this.#sentPath(record.botId, record.key), sent);
    return { broughtBack: fetch, skipped, conflicts };
  }

  async run(box: RunBox, input: { botId: string; folder: string; subdir?: string; command: string; active?: () => boolean; left?: () => number; started?: (record: RunRecord) => void }): Promise<RunOutcome> {
    const left = input.left ?? this.window();
    const started = await this.start(box, { ...input, left });
    return this.finish(box, started, { sentFiles: started.sentFiles, sentBytes: started.sentBytes }, left);
  }

  async finish(box: RunBox, record: RunRecord, sent = { sentFiles: 0, sentBytes: 0 }, left: () => number = this.window()): Promise<RunOutcome> {
    const state = await this.wait(box, record, left);
    if (!state.done) {
      const overdue = this.#now() - record.startedAt >= MAX_RUN_MS;
      if (overdue) await this.stop(box, record).catch(() => "alive");
      return { id: record.id, state: overdue ? "failed" : "running", exitCode: null, output: state.output, broughtBack: [], skipped: [], ...sent,
        note: overdue ? "Stopped after 2 hours." : `Still running. Call run_on_computer again with run_id "${record.id}" to keep waiting.` };
    }
    if (left() <= 0) return { id: record.id, state: "running", exitCode: state.exitCode, output: state.output, broughtBack: [], skipped: [], ...sent,
      note: `It finished, but this call ran out of time before bringing its files back. Call run_on_computer again with run_id "${record.id}" to bring them back.` };
    const back = await this.bringBack(box, record);
    const conflictNote = back.conflicts.length ? ` Kept your copy of ${back.conflicts.length} file(s) changed here while it ran: ${back.conflicts.slice(0, 10).join(", ")}.` : "";
    const reusedNote = record.reusedSetup ? " Reused the packages already installed for another copy of this project on your computer." : "";
    const skippedNote = back.skipped.length ? ` Left ${back.skipped.length} large file(s) on the computer: ${back.skipped.slice(0, 10).join(", ")}.` : "";
    return { id: record.id, state: "finished", exitCode: state.exitCode, output: state.output, broughtBack: back.broughtBack, skipped: back.skipped, ...sent,
      ...(reusedNote || conflictNote || skippedNote ? { note: (reusedNote + conflictNote + skippedNote).trim() } : {}) };
  }
}
