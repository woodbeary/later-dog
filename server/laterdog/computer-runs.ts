import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { BUILD_OUTPUT_DIRS } from "./janitor.ts";

export const PART_BYTES = 12 * 1024 * 1024;
export const MAX_SEND_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_BRING_BACK_BYTES = 512 * 1024 * 1024;
export const WAIT_IN_ONE_CALL_MS = 4 * 60_000;
export const MAX_RUN_MS = 2 * 60 * 60_000;
export const POLL_MS = 10_000;
export const OUTPUT_TAIL_CHARS = 12_000;
const EXEC_MS = 110_000;
const SKIPPED_NAMES: ReadonlySet<string> = new Set([...BUILD_OUTPUT_DIRS, ".pnpm-store", ".npm", "dist", "build", "out", "coverage", "test-results", "playwright-report"]);
const NEVER_SENT: ReadonlySet<string> = new Set([...BUILD_OUTPUT_DIRS, ".pnpm-store", ".npm"]);

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
  restAfter?: boolean;
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

export function stampFolder(folder: string): FolderStamps {
  const stamps: FolderStamps = {};
  const walk = (at: string) => {
    let names: string[] = [];
    try { names = readdirSync(at); } catch { return; }
    for (const name of names) {
      const path = join(at, name);
      let entry;
      try { entry = lstatSync(path); } catch { continue; }
      if (entry.isDirectory()) {
        if (NEVER_SENT.has(name)) continue;
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
  const changed = Object.keys(now).filter((path) => before[path]?.size !== now[path].size || before[path]?.mtimeMs !== now[path].mtimeMs).sort();
  const removed = Object.keys(before).filter((path) => !(path in now)).sort();
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
    if (!path || path.split("/").some((part) => part === ".." || SKIPPED_NAMES.has(part))) continue;
    if (total + size > maxBytes) { skipped.push(path); continue; }
    total += size;
    take.push(path);
  }
  return { take, skipped };
}

export function homeChangedSince(folder: string, paths: readonly string[], since: number): string[] {
  return paths.filter((path) => {
    try { return lstatSync(join(folder, path)).mtimeMs > since; } catch { return false; }
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

  async start(box: RunBox, input: { botId: string; folder: string; subdir?: string; command: string; restAfter?: boolean }): Promise<RunRecord & { sentFiles: number; sentBytes: number }> {
    const key = runKey(input.folder);
    const id = randomUUID().slice(0, 8);
    const remote = `runs/${key}`;
    const now = stampFolder(input.folder);
    const before = this.#readJson<FolderStamps>(this.#sentPath(input.botId, key));
    const present = before ? (await box.exec(`test -d ${quote(remote)} && echo yes || echo no`, 30_000)).stdout.trim() === "yes" : false;
    const { changed, removed } = changesSince(present && before ? before : {}, now);
    const sentBytes = changed.reduce((sum, path) => sum + now[path].size, 0);
    if (sentBytes > MAX_SEND_BYTES) throw new Error(`that folder has ${Math.round(sentBytes / 1024 / 1024)} MB to send; the most is ${MAX_SEND_BYTES / 1024 / 1024} MB. Pick a smaller folder.`);
    must(await box.exec(`mkdir -p ${quote(remote)} runs/.in runs/.logs && rm -f runs/.in/${id}.*`, 30_000), "preparing the folder");
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
    const subdir = (input.subdir ?? "").replace(/^\/+|\/+$/g, "");
    const workDir = subdir ? `${remote}/${subdir}` : remote;
    const script = `export PATH="$HOME/.local/bin:$PATH"; command -v pnpm > /dev/null || npm install -g --prefix "$HOME/.local" pnpm > /dev/null 2>&1; cd ${quote(workDir)} && touch "$HOME/runs/.logs/${id}.start" && ( ${input.command} ) > "$HOME/runs/.logs/${id}.log" 2>&1; echo $? > "$HOME/runs/.logs/${id}.exit"`;
    const detached = `nohup bash -lc ${quote(script)} > /dev/null 2>&1 < /dev/null &`;
    must(await box.exec(`if command -v setsid > /dev/null; then setsid ${detached} else ${detached} fi; echo started`, 30_000), "starting the command");
    const record: RunRecord = { id, botId: input.botId, key, folder: input.folder, subdir, command: input.command, startedAt: this.#now(), sent: now, ...(input.restAfter ? { restAfter: true } : {}) };
    this.#writeJson(this.#runPath(input.botId, id), record);
    return { ...record, sentFiles: changed.length, sentBytes };
  }

  record(botId: string, id: string): RunRecord | null {
    return /^[0-9a-f]{8}$/.test(id) ? this.#readJson<RunRecord>(this.#runPath(botId, id)) : null;
  }

  async poll(box: RunBox, record: RunRecord): Promise<{ done: boolean; exitCode: number | null; output: string }> {
    const result = await box.exec(`cat runs/.logs/${record.id}.exit 2>/dev/null; echo '<<<'; tail -c ${OUTPUT_TAIL_CHARS} runs/.logs/${record.id}.log 2>/dev/null`, 30_000);
    const [head, ...rest] = result.stdout.split("<<<\n");
    const code = head.trim();
    return { done: code !== "", exitCode: code === "" ? null : Number(code), output: rest.join("<<<\n") };
  }

  async wait(box: RunBox, record: RunRecord, budgetMs = WAIT_IN_ONE_CALL_MS) {
    const until = this.#now() + budgetMs;
    for (;;) {
      const state = await this.poll(box, record);
      if (state.done || this.#now() >= until || this.#now() - record.startedAt >= MAX_RUN_MS) return state;
      await this.#sleep(POLL_MS);
    }
  }

  async bringBack(box: RunBox, record: RunRecord): Promise<{ broughtBack: string[]; skipped: string[]; conflicts: string[] }> {
    const remote = `runs/${record.key}`;
    const lister = `import os,sys\nskip=set(sys.argv[2].split(","))\nsince=os.stat(sys.argv[1]).st_mtime\nfor root,dirs,files in os.walk("."):\n  dirs[:]=[d for d in dirs if d not in skip]\n  for f in files:\n    p=os.path.join(root,f)\n    try: st=os.lstat(p)\n    except OSError: continue\n    if st.st_mtime>since: print(f"{st.st_size}\\t{p}")\n`;
    const listing = must(await box.exec(`cd ${quote(remote)} && python3 -c ${quote(lister)} ../.logs/${record.id}.start ${quote([...SKIPPED_NAMES].join(","))}`, EXEC_MS), "listing changed files");
    const { take, skipped } = bringBackList(listing.stdout);
    const conflicts = homeChangedSince(record.folder, take, record.startedAt);
    const fetch = take.filter((path) => !conflicts.includes(path));
    if (!fetch.length) return { broughtBack: [], skipped, conflicts };
    await box.write(`runs/.in/${record.id}.back`, Buffer.from(fetch.map((path) => `${path}\0`).join("")));
    const packed = must(await box.exec(`cd ${quote(remote)} && tar -czf - --null -T ../.in/${record.id}.back | split -b ${PART_BYTES} -a 4 - ../.in/${record.id}.out. && ls ../.in/ | grep '^${record.id}\\.out\\.' | sort`, EXEC_MS), "packing the results");
    const pieces: Buffer[] = [];
    for (const name of packed.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) pieces.push(await box.read(`runs/.in/${name}`));
    await box.exec(`rm -f runs/.in/${record.id}.*`, 30_000).catch(() => null);
    await unpackFiles(record.folder, Buffer.concat(pieces));
    const sent = { ...record.sent, ...stampFolder(record.folder) };
    this.#writeJson(this.#sentPath(record.botId, record.key), sent);
    return { broughtBack: fetch, skipped, conflicts };
  }

  async run(box: RunBox, input: { botId: string; folder: string; subdir?: string; command: string; restAfter?: boolean }): Promise<RunOutcome> {
    const started = await this.start(box, input);
    return this.finish(box, started, { sentFiles: started.sentFiles, sentBytes: started.sentBytes });
  }

  async finish(box: RunBox, record: RunRecord, sent = { sentFiles: 0, sentBytes: 0 }): Promise<RunOutcome> {
    const state = await this.wait(box, record);
    if (!state.done) {
      const overdue = this.#now() - record.startedAt >= MAX_RUN_MS;
      if (overdue) await box.exec(`pkill -f ${quote(`runs/.logs/${record.id}.log`)}`, 30_000).catch(() => null);
      return { id: record.id, state: overdue ? "failed" : "running", exitCode: null, output: state.output, broughtBack: [], skipped: [], ...sent,
        note: overdue ? "Stopped after 2 hours." : `Still running. Call run_on_computer again with run_id "${record.id}" to keep waiting.` };
    }
    const back = await this.bringBack(box, record);
    const conflictNote = back.conflicts.length ? ` Kept your copy of ${back.conflicts.length} file(s) changed here while it ran: ${back.conflicts.slice(0, 10).join(", ")}.` : "";
    const skippedNote = back.skipped.length ? ` Left ${back.skipped.length} large file(s) on the computer: ${back.skipped.slice(0, 10).join(", ")}.` : "";
    return { id: record.id, state: "finished", exitCode: state.exitCode, output: state.output, broughtBack: back.broughtBack, skipped: back.skipped, ...sent,
      ...(conflictNote || skippedNote ? { note: (conflictNote + skippedNote).trim() } : {}) };
  }
}
