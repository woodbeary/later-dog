import { closeSync, constants, mkdirSync, openSync, readdirSync, writeSync } from "node:fs";
import { mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { mask, redactSecretsInText } from "../../shared/redact.ts";

export const HOME_SERVER_LOG_DIR = "logs";
export const HOME_SERVER_LOG_SEGMENT_BYTES = 4 * 1024 * 1024;
export const HOME_SERVER_LOG_SEGMENTS_KEPT = 32;
export const HOME_SERVER_LOG_BUFFER_BYTES = 4 * 1024 * 1024;
export const HOME_SERVER_LOG_LINE_BYTES = 64 * 1024;
export const HOME_LOG_DEFAULT_LINES = 200;
export const HOME_LOG_MAX_LINES = 2_000;
export const HOME_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const HOME_LOG_MAX_SCANNED_BYTES = 64 * 1024 * 1024;

const SEGMENT = /^server-(\d+)\.log$/;
const SESSION_TOKEN = /\blaterdog_sess_[A-Za-z0-9_-]{16,}/g;
const APPEND_NEVER_THROUGH_A_LINK = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;

export function maskHomeLogLine(line: string): string {
  return redactSecretsInText(line.replace(SESSION_TOKEN, (token) => mask(token)));
}

export function segmentName(index: number): string {
  return `server-${index}.log`;
}

export function segmentIndex(name: string): number | null {
  const match = SEGMENT.exec(name);
  return match ? Number(match[1]) : null;
}

async function segmentIndexes(dir: string): Promise<number[]> {
  try {
    return (await readdir(dir)).map(segmentIndex).filter((index): index is number => index !== null).sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export type HomeServerLogOptions = {
  dir: string;
  now?: () => Date;
  segmentBytes?: number;
  segmentsKept?: number;
  bufferBytes?: number;
  lineBytes?: number;
};

export type HomeServerLog = {
  write(chunk: unknown, stream?: "stdout" | "stderr"): void;
  flush(): Promise<void>;
  flushSync(): void;
  dropped(): number;
};

export function createHomeServerLog(options: HomeServerLogOptions): HomeServerLog {
  const dir = options.dir;
  const now = options.now ?? (() => new Date());
  const segmentBytes = options.segmentBytes ?? HOME_SERVER_LOG_SEGMENT_BYTES;
  const segmentsKept = Math.max(1, options.segmentsKept ?? HOME_SERVER_LOG_SEGMENTS_KEPT);
  const bufferBytes = options.bufferBytes ?? HOME_SERVER_LOG_BUFFER_BYTES;
  const lineBytes = options.lineBytes ?? HOME_SERVER_LOG_LINE_BYTES;
  const partial = { stdout: { text: "", at: "" }, stderr: { text: "", at: "" } };
  let queue: string[] = [];
  let queuedBytes = 0;
  let droppedLines = 0;
  let droppedUnsaid = 0;
  let current: { index: number; size: number } | null = null;
  let running: Promise<void> | null = null;

  const enqueue = (entry: string) => {
    const bytes = Buffer.byteLength(entry);
    if (queuedBytes + bytes > bufferBytes) {
      droppedLines++;
      droppedUnsaid++;
      return;
    }
    if (droppedUnsaid) {
      const note = `${now().toISOString()} home log: dropped ${droppedUnsaid} line${droppedUnsaid === 1 ? "" : "s"} because the disk fell behind\n`;
      droppedUnsaid = 0;
      queue.push(note);
      queuedBytes += Buffer.byteLength(note);
    }
    queue.push(entry);
    queuedBytes += bytes;
  };

  const line = (text: string, at: string) => enqueue(`${at} ${maskHomeLogLine(text.length > lineBytes ? text.slice(0, lineBytes) : text)}\n`);

  const take = (stream: "stdout" | "stderr", text: string) => {
    const open = partial[stream];
    let rest = text;
    let newline = rest.indexOf("\n");
    while (newline !== -1) {
      const piece = open.text + rest.slice(0, newline);
      line(piece.endsWith("\r") ? piece.slice(0, -1) : piece, open.text ? open.at : now().toISOString());
      open.text = "";
      rest = rest.slice(newline + 1);
      newline = rest.indexOf("\n");
    }
    if (rest) {
      if (!open.text) open.at = now().toISOString();
      open.text += rest;
      if (open.text.length >= lineBytes) {
        line(open.text, open.at);
        open.text = "";
      }
    }
  };

  const closeOpenLines = () => {
    for (const stream of ["stdout", "stderr"] as const) {
      if (partial[stream].text) line(partial[stream].text, partial[stream].at);
      partial[stream].text = "";
    }
  };

  const startSegment = async () => {
    const indexes = await segmentIndexes(dir);
    const last = indexes.at(-1);
    if (last === undefined) return { index: 1, size: 0 };
    const size = await stat(join(dir, segmentName(last))).then((found) => found.size, () => null);
    if (size !== null && size < segmentBytes) return { index: last, size };
    await pruneForNewSegment();
    return { index: last + 1, size: 0 };
  };

  const pruneForNewSegment = async () => {
    const indexes = await segmentIndexes(dir);
    for (const index of indexes.slice(0, Math.max(0, indexes.length - (segmentsKept - 1)))) {
      await rm(join(dir, segmentName(index)), { force: true }).catch(() => undefined);
    }
  };

  const nextBatch = (segment: { index: number; size: number }): string[] => {
    const batch: string[] = [];
    let size = segment.size;
    while (queue.length) {
      const bytes = Buffer.byteLength(queue[0]!);
      if (size > 0 && size + bytes > segmentBytes) break;
      batch.push(queue.shift()!);
      queuedBytes -= bytes;
      size += bytes;
    }
    return batch;
  };

  const drain = async () => {
    while (queue.length) {
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        current ??= await startSegment();
        const batch = nextBatch(current);
        if (!batch.length) {
          current = { index: current.index + 1, size: 0 };
          await pruneForNewSegment();
          continue;
        }
        const text = batch.join("");
        const handle = await open(join(dir, segmentName(current.index)), APPEND_NEVER_THROUGH_A_LINK, 0o600);
        try { await handle.write(text); } finally { await handle.close(); }
        current.size += Buffer.byteLength(text);
        if (current.size >= segmentBytes) {
          current = { index: current.index + 1, size: 0 };
          await pruneForNewSegment();
        }
      } catch {
        droppedLines += queue.length;
        droppedUnsaid += queue.length;
        queue = [];
        queuedBytes = 0;
        current = null;
      }
    }
  };

  const schedule = () => {
    if (running || !queue.length) return;
    running = drain().finally(() => {
      running = null;
      schedule();
    });
  };

  return {
    write(chunk, stream = "stdout") {
      try {
        const text = typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : null;
        if (!text) return;
        take(stream, text);
        schedule();
      } catch {
        return;
      }
    },
    async flush() {
      closeOpenLines();
      schedule();
      while (running) await running;
    },
    flushSync() {
      try {
        closeOpenLines();
        if (!queue.length) return;
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const latest = readdirSync(dir).map(segmentIndex).reduce<number>((top, index) => Math.max(top, index ?? 0), 0);
        const target = join(dir, segmentName(current?.index ?? Math.max(latest, 1)));
        const fd = openSync(target, APPEND_NEVER_THROUGH_A_LINK, 0o600);
        try { writeSync(fd, queue.join("")); } finally { closeSync(fd); }
        queue = [];
        queuedBytes = 0;
      } catch {
        return;
      }
    },
    dropped: () => droppedLines,
  };
}

type Writable = { write: (...args: never[]) => boolean };

export type HomeServerLogInstall = HomeServerLogOptions & {
  stdout?: Writable;
  stderr?: Writable;
  onExit?: (run: () => void) => void;
};

export function installHomeServerLog(options: HomeServerLogInstall): { log: HomeServerLog; uninstall: () => void } {
  const log = createHomeServerLog(options);
  const streams = { stdout: options.stdout ?? process.stdout, stderr: options.stderr ?? process.stderr } as const;
  const originals = { stdout: streams.stdout.write, stderr: streams.stderr.write };
  for (const name of ["stdout", "stderr"] as const) {
    const original = originals[name];
    const tee = function (this: unknown, ...args: unknown[]) {
      log.write(args[0], name);
      return (original as (...rest: unknown[]) => boolean).apply(this, args);
    };
    (streams[name] as { write: unknown }).write = tee;
  }
  (options.onExit ?? ((run) => process.once("exit", run)))(() => log.flushSync());
  return {
    log,
    uninstall: () => {
      (streams.stdout as { write: unknown }).write = originals.stdout;
      (streams.stderr as { write: unknown }).write = originals.stderr;
    },
  };
}

export type HomeLogQuery = { lines?: number; contains?: string; since?: string };

export function parseHomeLogQuery(params: URLSearchParams): HomeLogQuery | string {
  const query: HomeLogQuery = {};
  const lines = params.get("lines");
  if (lines !== null) {
    if (!/^\d+$/.test(lines) || Number(lines) < 1) return "lines must be a whole number from 1";
    query.lines = Math.min(Number(lines), HOME_LOG_MAX_LINES);
  }
  const contains = params.get("contains");
  if (contains) query.contains = contains.slice(0, 500);
  const since = params.get("since");
  if (since) {
    const at = new Date(since);
    if (Number.isNaN(at.getTime())) return "since must be a time such as 2026-11-25T18:00:00Z";
    query.since = at.toISOString();
  }
  return query;
}

export async function readHomeLog(dir: string, query: HomeLogQuery = {}): Promise<string> {
  const wanted = Math.min(query.lines ?? HOME_LOG_DEFAULT_LINES, HOME_LOG_MAX_LINES);
  const kept: string[] = [];
  let keptBytes = 0;
  let scanned = 0;
  const indexes = (await segmentIndexes(dir)).reverse();
  outer: for (const index of indexes) {
    if (scanned >= HOME_LOG_MAX_SCANNED_BYTES) break;
    let text: string;
    try { text = await readFile(join(dir, segmentName(index)), "utf8"); } catch { continue; }
    scanned += Buffer.byteLength(text);
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = lines[i]!;
      if (query.since && entry.slice(0, 24) < query.since) break outer;
      if (query.contains && !entry.includes(query.contains)) continue;
      const shown = maskHomeLogLine(entry);
      const bytes = Buffer.byteLength(shown) + 1;
      if (keptBytes + bytes > HOME_LOG_MAX_BYTES) break outer;
      kept.push(shown);
      keptBytes += bytes;
      if (kept.length >= wanted) break outer;
    }
  }
  return kept.length ? `${kept.reverse().join("\n")}\n` : "";
}
