import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { JobTrace } from "../../shared/laterdog.ts";

export const TRACE_DEFAULT_RETENTION_DAYS = 30;
export const TRACE_MAX_RETENTION_DAYS = 365;
export const MAX_TRACE_GZIP_BYTES = 16 * 1024 * 1024;
export const MAX_TRACE_RAW_BYTES = 64 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET_PATTERNS = [/sk-ant-[A-Za-z0-9_-]{20,}/g, /gh[pousr]_[A-Za-z0-9]{30,}/g, /github_pat_[A-Za-z0-9_]{30,}/g];

export interface TraceCapture { gz: Buffer; truncated: boolean; rawBytes: number }

export interface TraceUpload { retentionDays: number; truncated: boolean }

export interface JobTraceStore {
  readonly where: JobTrace["where"];
  put(jobId: string, gz: Buffer, upload: TraceUpload): Promise<JobTrace>;
  get(jobId: string): Promise<Buffer | null>;
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

export function redactTrace(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

export function captureTrace(gz: Buffer, truncated: boolean, secrets: readonly string[]): TraceCapture {
  const raw = gunzipSync(gz, { maxOutputLength: MAX_TRACE_RAW_BYTES * 2 }).toString("utf8");
  const clean = Buffer.from(redactTrace(raw, secrets), "utf8");
  return { gz: gzipSync(clean, { level: 9 }), truncated, rawBytes: clean.length };
}

export function readableTrace(gz: Buffer): Buffer {
  return gunzipSync(gz, { maxOutputLength: MAX_TRACE_RAW_BYTES * 2 });
}

export const TRACE_COMMAND = [
  "set -u",
  'T="$HOME/task"; f="$T/out.jsonl"',
  '[ -s "$f" ] || { echo none; exit 0; }',
  'raw=$(wc -c < "$f")',
  `if [ "$raw" -gt ${MAX_TRACE_RAW_BYTES} ]; then tail -c ${MAX_TRACE_RAW_BYTES} "$f" | tail -n +2 | gzip -9 > "$T/trace.jsonl.gz"; echo "truncated $raw"; else gzip -9 -c "$f" > "$T/trace.jsonl.gz"; echo "whole $raw"; fi`,
  'wc -c < "$T/trace.jsonl.gz"',
].join("\n");

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
    const response = await this.#fetch(`${this.#url}/${traceKey(jobId)}`, { method: "PUT", body: new Uint8Array(gz), signal: AbortSignal.timeout(120_000),
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
  async get(jobId: string): Promise<Buffer | null> {
    const response = await this.#fetch(`${this.#url}/${traceKey(jobId)}`, { headers: this.#headers(), signal: AbortSignal.timeout(120_000) });
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new Error(`the trace store answered ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_TRACE_GZIP_BYTES) throw new Error("the stored trace is larger than the limit");
    return bytes;
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
    writeFileSync(this.#file(jobId), gz, { mode: 0o600 });
    const storedAt = this.#now();
    return { where: "local", bytes: gz.length, storedAt: storedAt.toISOString(), expiresAt: traceExpiry(storedAt, upload.retentionDays), truncated: upload.truncated };
  }
  async get(jobId: string): Promise<Buffer | null> {
    const file = this.#file(jobId);
    return existsSync(file) ? readFileSync(file) : null;
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
