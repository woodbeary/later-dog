import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Readable, Transform, pipeline } from "node:stream";
import { promisify } from "node:util";
import { createGunzip, gunzip, gzip } from "node:zlib";
import type { JobTrace } from "../../shared/laterdog.ts";
import { redactTrace, redactTraceYielding } from "./trace-scrub.ts";

export { redactTrace };

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

export const TRACE_DEFAULT_RETENTION_DAYS = 30;
export const TRACE_MAX_RETENTION_DAYS = 365;
export const MAX_TRACE_GZIP_BYTES = 16 * 1024 * 1024;
export const MAX_TRACE_RAW_BYTES = 64 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface TraceCapture { gz: Buffer; truncated: boolean; rawBytes: number }

export interface TraceUpload { retentionDays: number; truncated: boolean; signal?: AbortSignal }

export interface JobTraceStore {
  readonly where: JobTrace["where"];
  put(jobId: string, gz: Buffer, upload: TraceUpload): Promise<JobTrace>;
  open(jobId: string): Promise<Readable | null>;
}

export function limitBytes(max: number, what: string): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > max) done(new Error(`${what} is larger than the ${max}-byte limit`));
      else done(null, chunk);
    },
  });
}

export function readableTraceStream(gz: Readable): Readable {
  const out = new PassThrough();
  pipeline(gz, limitBytes(MAX_TRACE_GZIP_BYTES, "The stored trace"), createGunzip(), limitBytes(MAX_TRACE_RAW_BYTES * 2, "The trace"), out, () => undefined);
  return out;
}

export function traceRetentionDays(env: NodeJS.ProcessEnv): number {
  const raw = env.LATERDOG_TRACE_RETENTION_DAYS?.trim();
  if (!raw) return TRACE_DEFAULT_RETENTION_DAYS;
  const days = Number(raw);
  return Number.isInteger(days) && days >= 1 && days <= TRACE_MAX_RETENTION_DAYS ? days : TRACE_DEFAULT_RETENTION_DAYS;
}

export function traceKey(jobId: string): string {
  if (!JOB_ID.test(jobId)) throw new Error("Invalid job id for a trace");
  return `traces/${jobId}.jsonl.gz`;
}

export function traceExpiry(storedAt: Date, retentionDays: number): string {
  return new Date(storedAt.getTime() + retentionDays * DAY_MS).toISOString();
}

export function traceExpired(trace: Pick<JobTrace, "expiresAt">, now = Date.now()): boolean {
  return Date.parse(trace.expiresAt) <= now;
}

export async function captureTrace(gz: Buffer, truncated: boolean, secrets: readonly string[]): Promise<TraceCapture> {
  const raw = (await gunzipAsync(gz, { maxOutputLength: MAX_TRACE_RAW_BYTES * 2 })).toString("utf8");
  const clean = Buffer.from(await redactTraceYielding(raw, secrets), "utf8");
  return { gz: await gzipAsync(clean, { level: 9 }), truncated, rawBytes: clean.length };
}

export const TRACE_TAILS = [MAX_TRACE_RAW_BYTES, 32 * 1024 * 1024, 16 * 1024 * 1024, 8 * 1024 * 1024, 4 * 1024 * 1024, 2 * 1024 * 1024, 1024 * 1024] as const;

export function traceCommand(limits: { rawBytes: number; gzipBytes: number; tails: readonly number[] } = { rawBytes: MAX_TRACE_RAW_BYTES, gzipBytes: MAX_TRACE_GZIP_BYTES, tails: TRACE_TAILS }): string {
  return [
    "set -u",
    'T="$HOME/task"; f="$T/out.jsonl"; g="$T/trace.jsonl.gz"',
    '[ -s "$f" ] || { echo none; exit 0; }',
    'raw=$(wc -c < "$f")',
    "word=whole; size=0",
    `for n in whole ${limits.tails.join(" ")}; do`,
    '  if [ "$n" = whole ]; then',
    `    [ "$raw" -le ${limits.rawBytes} ] || continue`,
    '    gzip -9 -c "$f" > "$g"; word=whole',
    "  else",
    '    [ "$raw" -gt "$n" ] || continue',
    "    word=truncated",
    `    if [ "$(tail -c $((n + 1)) "$f" | head -c 1 | od -An -c | tr -d ' ')" = '\\n' ]; then tail -c "$n" "$f"; else tail -c "$n" "$f" | tail -n +2; fi | gzip -9 > "$g"`,
    "  fi",
    '  size=$(wc -c < "$g")',
    `  [ "$size" -le ${limits.gzipBytes} ] && break`,
    "done",
    'echo "$word $raw"',
    'echo "$size"',
  ].join("\n");
}

export const TRACE_COMMAND = traceCommand();

export function parseTraceReport(stdout: string): { kind: "none" } | { kind: "kept"; truncated: boolean; rawBytes: number; gzipBytes: number } {
  const [first = "", second = ""] = stdout.trim().split("\n");
  if (first.trim() === "none") return { kind: "none" };
  const [word, raw] = first.trim().split(/\s+/);
  const rawBytes = Number.parseInt(raw ?? "", 10);
  const gzipBytes = Number.parseInt(second.trim(), 10);
  if ((word !== "whole" && word !== "truncated") || !Number.isInteger(rawBytes) || rawBytes < 0 || !Number.isInteger(gzipBytes) || gzipBytes < 0) throw new Error("The computer reported an unreadable trace size");
  return { kind: "kept", truncated: word === "truncated", rawBytes, gzipBytes };
}

export class StateTraceStore implements JobTraceStore {
  readonly where = "r2" as const;
  readonly #url: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  constructor(stateUrl: string, options: { token?: string; fetch?: typeof fetch; now?: () => Date } = {}) {
    this.#url = stateUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }
  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}), ...extra };
  }
  async put(jobId: string, gz: Buffer, upload: TraceUpload): Promise<JobTrace> {
    const response = await this.#fetch(`${this.#url}/${traceKey(jobId)}`, { method: "PUT", body: new Uint8Array(gz), signal: upload.signal ?? AbortSignal.timeout(120_000),
      headers: this.#headers({ "content-type": "application/gzip", "x-laterdog-retain-days": String(upload.retentionDays), "x-laterdog-truncated": upload.truncated ? "1" : "0" }) });
    if (!response.ok) throw new Error(`the trace store answered ${response.status}`);
    const storedAt = this.#now();
    let expiresAt = traceExpiry(storedAt, upload.retentionDays);
    try {
      const answer = await response.json() as { expiresAt?: unknown };
      if (typeof answer.expiresAt === "string" && Number.isFinite(Date.parse(answer.expiresAt))) expiresAt = new Date(answer.expiresAt).toISOString();
    } catch { expiresAt = traceExpiry(storedAt, upload.retentionDays); }
    return { where: "r2", bytes: gz.length, storedAt: storedAt.toISOString(), expiresAt, truncated: upload.truncated };
  }
  async open(jobId: string): Promise<Readable | null> {
    const response = await this.#fetch(`${this.#url}/${traceKey(jobId)}`, { headers: this.#headers(), signal: AbortSignal.timeout(120_000) });
    if (response.status === 404 || response.status === 410) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`the trace store answered ${response.status}`); }
    const announced = Number(response.headers.get("content-length"));
    if (Number.isFinite(announced) && announced > MAX_TRACE_GZIP_BYTES) { await response.body?.cancel(); throw new Error("the stored trace is larger than the limit"); }
    if (!response.body) return null;
    return Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  }
}

export class LocalTraceStore implements JobTraceStore {
  readonly where = "local" as const;
  readonly #dir: string;
  readonly #now: () => Date;
  constructor(dir: string, now: () => Date = () => new Date()) {
    this.#dir = dir;
    this.#now = now;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  #file(jobId: string): string { return join(this.#dir, `${traceKey(jobId).slice("traces/".length)}`); }
  async put(jobId: string, gz: Buffer, upload: TraceUpload): Promise<JobTrace> {
    await writeFile(this.#file(jobId), gz, { mode: 0o600 });
    const storedAt = this.#now();
    return { where: "local", bytes: gz.length, storedAt: storedAt.toISOString(), expiresAt: traceExpiry(storedAt, upload.retentionDays), truncated: upload.truncated };
  }
  async open(jobId: string): Promise<Readable | null> {
    const file = this.#file(jobId);
    return existsSync(file) ? createReadStream(file) : null;
  }
  forget(jobId: string): void {
    const file = this.#file(jobId);
    if (existsSync(file)) unlinkSync(file);
  }
  sweep(keep: ReadonlySet<string>): number {
    let removed = 0;
    for (const name of readdirSync(this.#dir)) {
      const jobId = name.replace(/\.jsonl\.gz$/, "");
      if (!JOB_ID.test(jobId) || keep.has(jobId)) continue;
      if (statSync(join(this.#dir, name)).isFile()) { unlinkSync(join(this.#dir, name)); removed += 1; }
    }
    return removed;
  }
}

export function jobTraceStoreFromEnv(env: NodeJS.ProcessEnv, dataDir: string): { primary: JobTraceStore; local: LocalTraceStore } {
  const local = new LocalTraceStore(join(dataDir, "traces"));
  const stateUrl = env.LATERDOG_STATE_URL?.trim();
  return { primary: stateUrl ? new StateTraceStore(stateUrl, { token: env.LATERDOG_STATE_TOKEN?.trim() || undefined }) : local, local };
}
