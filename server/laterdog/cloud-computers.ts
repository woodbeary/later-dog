// later.dog's own cloud computers: the client for the computers service on the person's Cloudflare account
// (deploy/laterdog/computers/). server/computers.ts decides when the server uses it instead of Boat.
// Only what the server acts on crosses this boundary: a computer's id, name and state. Desktop links, addresses and
// anything else the service adds are dropped at parse. The key is read when a client is made and lives only in the
// Authorization header: no message, log line or serialized client carries it.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const COMPUTER_ID = /^cmp_[A-Za-z0-9_-]{1,64}$/;
/** A compromised service can answer with an arbitrarily large frame; this is what one screenshot may buffer (boat.ts caps Boat's the same). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024; // exec output is the largest JSON answer
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const JSON_TYPE = { "content-type": "application/json" };

/** A choice of computers this installation cannot use as written. A route answers it with 409: the person fixes it. */
export class ComputersConfigError extends Error { readonly status = 409; }

/** The service refused, answered with something unexpected, or did not answer (httpStatus 0). Named apart from
 * `status`, which a route would answer with: server/computers.ts decides what a refusal means to its caller. */
export class ComputersApiError extends Error {
  readonly httpStatus: number;
  readonly code: string | undefined;
  constructor(message: string, httpStatus: number, code?: string, options?: ErrorOptions) {
    super(message, options); this.name = "ComputersApiError"; this.httpStatus = httpStatus; this.code = code;
  }
}

const dataDir = () => process.env.LATERDOG_HOME ?? join(homedir(), ".laterdog");
/** `<data>/computers.json`, beside supervisor.json: `{ "api": "https://…/v1", "keyFile"?: "/abs/path" }`. */
export const computersConnectionFile = (): string => join(dataDir(), "computers.json");
const defaultKeyFile = () => join(dataDir(), "computers-key");
const savedSchema = z.object({ api: z.string().min(1).max(2048),
  keyFile: z.string().min(1).transform((file) => file.replace(/^~(?=\/)/, homedir())).refine(isAbsolute, "keyFile must be an absolute path").optional() }).strict();
export interface ComputersConnection { api: string; keyFile: string; source: "environment" | "file" | "trial" }
export const TRIAL_KEY = /^ldt_[A-Za-z0-9_-]{43}$/;
export const trialKeyFile = (): string => join(dataDir(), "computers-trial-key");
export const trialStateFile = (): string => join(dataDir(), "computers-trial.json");
const trialSchema = z.object({ api: z.string().min(1).max(2048), confirmed: z.literal(true).optional(), ended: z.literal(true).optional() }).strict();
export type SavedTrial = z.infer<typeof trialSchema>;

export function savedTrial(): SavedTrial | null {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(trialStateFile(), "utf8")); } catch { return null; }
  const saved = trialSchema.safeParse(raw);
  if (!saved.success) return null;
  try { return { ...saved.data, api: serviceApi(saved.data.api) }; } catch { return null; }
}

function usableTrial(): SavedTrial | null {
  const saved = savedTrial();
  return saved?.confirmed === true && saved.ended !== true && existsSync(trialKeyFile()) ? saved : null;
}

export const trialInUse = (): boolean => usableTrial() !== null;

export function ownComputersChosen(): boolean {
  return Boolean(process.env.LATERDOG_COMPUTERS_API?.trim()) || existsSync(computersConnectionFile());
}

/** Whether this installation chose later.dog's own computers: the environment names a service, or computers.json
 * exists. A choice that turns out broken still counts, so it fails where the person can see it instead of quietly
 * sending every dog back to Boat. */
export function computersSelected(): boolean {
  return ownComputersChosen() || trialInUse();
}

/** Which computers service this installation uses, or null for none. As with supervisor.json (config.ts):
 * LATERDOG_COMPUTERS_API wins, with LATERDOG_COMPUTERS_KEY_FILE; then the saved file. Either way the key file
 * defaults to `<data>/computers-key`. */
export function computersConnection(): ComputersConnection | null {
  const api = process.env.LATERDOG_COMPUTERS_API?.trim();
  if (api) {
    const keyFile = process.env.LATERDOG_COMPUTERS_KEY_FILE?.trim() || defaultKeyFile();
    if (!isAbsolute(keyFile)) throw new ComputersConfigError("LATERDOG_COMPUTERS_KEY_FILE must be an absolute path");
    return { api: serviceApi(api), keyFile, source: "environment" };
  }
  const file = computersConnectionFile();
  if (!existsSync(file)) {
    const trial = usableTrial();
    return trial ? { api: trial.api, keyFile: trialKeyFile(), source: "trial" } : null;
  }
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { throw new ComputersConfigError(`${file} is not valid JSON`); }
  // Issue messages name keys and expected types, never values: a key pasted into the wrong field stays out of them.
  const saved = savedSchema.safeParse(raw);
  if (!saved.success) throw new ComputersConfigError(`${file} is invalid: ${saved.error.issues.map((issue) => issue.message).join("; ")}`);
  return { api: serviceApi(saved.data.api), keyFile: saved.data.keyFile ?? defaultKeyFile(), source: "file" };
}

/** HTTPS, or HTTP to this machine for a local stub; never credentials, a query or a fragment, which logs would keep.
 * The raw value is never echoed, since it may hold exactly such a credential. */
export function serviceApi(raw: string): string {
  let url: URL | null = null;
  try { url = new URL(raw); } catch { /* refused below */ }
  if (!url || url.username || url.password || url.search || url.hash || !httpsOrLoopback(url)) {
    throw new ComputersConfigError("Use a credential-free HTTPS later.dog computers API, or loopback HTTP");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
const httpsOrLoopback = (url: URL) => url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));

/** The bearer for a connection. A pasted Boat key or a stray character would only produce 401s minutes later in
 * another panel, so the file is judged now, by its path and never by its contents. */
export function computersKey(connection: ComputersConnection): string {
  let key: string;
  try { key = readFileSync(connection.keyFile, "utf8").trim(); }
  catch (error) {
    const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    throw new ComputersConfigError(`The later.dog computers key file ${connection.keyFile} ${missing ? "does not exist" : "could not be read"}`);
  }
  if (connection.source === "trial") {
    if (!TRIAL_KEY.test(key)) throw new ComputersConfigError(`${connection.keyFile} does not hold a later.dog free trial key`);
  } else if (!/^ldc_[!-~]{8,1024}$/.test(key)) throw new ComputersConfigError(`${connection.keyFile} does not hold a later.dog computers key (they start with ldc_)`);
  return key;
}

const computerSchema = z.object({ id: z.string().regex(COMPUTER_ID), name: z.string().min(1).max(200).regex(/^[^\r\n]*$/), state: z.string().min(1).max(40) });
export type Computer = z.infer<typeof computerSchema>;
const computerBody = z.object({ computer: computerSchema });
const listBody = z.object({ computers: z.array(computerSchema).max(10_000) });
const execBody = z.object({ exitCode: z.number().int().nullable(), stdout: z.string(), stderr: z.string() });
export type ExecResult = z.infer<typeof execBody>;
const desktopBody = z.object({ url: z.string().min(1).max(8192), expiresAt: z.union([z.string(), z.number()]).optional() });
const errorBody = z.object({ error: z.object({ code: z.string().optional(), message: z.string().optional() }) });
const trialBody = z.object({ trial: z.object({ state: z.enum(["active", "used_up"]), minutes: z.number().int().min(1).max(600),
  minutesLeft: z.number().int().min(0).max(600), expiresAt: z.string().min(1).max(64) }) });
export type TrialView = z.infer<typeof trialBody>["trial"];

const unexpected = (what = "an unexpected answer") => new ComputersApiError(`later.dog's computers service returned ${what}`, 502, "invalid_response");

/** The provider's own words are better than anything invented here (boat.ts boatErrorMessage), except for a rejected
 * key, where the fix is a file on this machine. */
function refusalMessage(status: number, theirs: string, keyFile: string, trial: boolean): string {
  if ((status === 401 || status === 403) && !trial) return `later.dog's computers service rejected the key in ${keyFile}`;
  if (theirs) return theirs;
  if (status === 404 || status === 410) return "that cloud computer no longer exists";
  if (status === 429) return "later.dog's computers service is rate-limiting this installation — wait a minute and try again";
  return `later.dog's computers service could not complete that request (${status})`;
}

/** Ids reach URL paths, so anything but the service's own id shape is refused before a request. */
function computerPath(id: string): string {
  if (!COMPUTER_ID.test(id)) throw Object.assign(new Error("invalid cloud computer id"), { status: 400 });
  return id;
}
function filesPath(id: string, path: string): string {
  if (!path || path.length > 4096 || path.includes("\0")) throw Object.assign(new Error("invalid file path"), { status: 400 });
  return `/computers/${computerPath(id)}/files?path=${encodeURIComponent(path)}`;
}

/** Buffer at most `maxBytes` of a body, whatever its Content-Length claims, so one answer cannot exhaust memory. */
export async function readCapped(response: Response, maxBytes: number, tooLarge: () => Error): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) { await response.body?.cancel().catch(() => {}); throw tooLarge(); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks, size);
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => {}); throw tooLarge(); }
    chunks.push(value);
  }
}

type Send = { method?: string; body?: RequestInit["body"]; headers?: Record<string, string>; accept?: string; timeoutMs?: number; signal?: AbortSignal };

/** One connection and key for the life of the client: server/computers.ts makes one per operation, so a key replaced
 * mid-provision applies to the next operation, never halfway through this one (boat.ts snapshotBoatConfig). */
export class ComputersClient {
  readonly api: string;
  readonly keyFile: string;
  readonly #key: string;
  readonly #trial: boolean;
  readonly #fetch: typeof fetch;
  constructor(connection: ComputersConnection, options: { fetch?: typeof fetch } = {}) {
    this.api = connection.api; this.keyFile = connection.keyFile; this.#key = computersKey(connection); this.#trial = connection.source === "trial"; this.#fetch = options.fetch ?? fetch;
  }

  /** Every request has a deadline: a service that accepts a connection and stalls must not hold a turn for minutes. */
  async #send(path: string, { method = "GET", body, headers = {}, accept = "application/json", timeoutMs = 20_000, signal }: Send = {}): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${this.api}${path}`, { method, body, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { accept, ...headers, authorization: `Bearer ${this.#key}` } });
    } catch (error) {
      if (signal?.aborted) throw error; // the caller's own cancel or deadline, as the caller set it
      throw new ComputersApiError(timeout.aborted ? "later.dog's computers service did not answer in time" : "later.dog's computers service could not be reached", 0, undefined, { cause: error });
    }
    if (response.ok) return response;
    let failure: unknown = null;
    try { failure = JSON.parse((await readCapped(response, MAX_ERROR_BYTES, () => unexpected())).toString("utf8")); } catch { /* the status alone speaks */ }
    const parsed = errorBody.safeParse(failure);
    const code = parsed.success && /^[a-z0-9_]{1,64}$/.test(parsed.data.error.code ?? "") ? parsed.data.error.code : undefined;
    const theirs = parsed.success ? (parsed.data.error.message ?? "").trim().slice(0, 300) : "";
    throw new ComputersApiError(refusalMessage(response.status, theirs, this.keyFile, this.#trial), response.status, code);
  }

  async #read<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    let body: unknown;
    try { body = JSON.parse((await readCapped(response, MAX_JSON_BYTES, () => unexpected("an answer over 16 MB"))).toString("utf8")); }
    catch (error) { throw error instanceof ComputersApiError ? error : unexpected(); }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw unexpected();
    return parsed.data;
  }

  /** Every computer on the account. One malformed row fails the whole list, so a service fault never reads as absence. */
  async list(): Promise<Computer[]> { return (await this.#read(await this.#send("/computers"), listBody)).computers; }

  /** The computer, or null once the service says it does not exist. */
  async get(id: string, options: { signal?: AbortSignal } = {}): Promise<Computer | null> {
    let response: Response;
    try { response = await this.#send(`/computers/${computerPath(id)}`, { signal: options.signal }); }
    catch (error) { if (error instanceof ComputersApiError && (error.httpStatus === 404 || error.httpStatus === 410)) return null; throw error; }
    const { computer } = await this.#read(response, computerBody);
    if (computer.id !== id) throw unexpected("a different cloud computer");
    return computer;
  }

  /** A dropped answer or a server error may follow a create that happened; one retry with the same key is safe. */
  async create(input: { name: string; size?: string }, idempotencyKey: string): Promise<Computer> {
    const send = () => this.#send("/computers", { method: "POST", body: JSON.stringify(input), timeoutMs: 45_000,
      headers: { ...JSON_TYPE, "idempotency-key": idempotencyKey } });
    let response: Response;
    try { response = await send(); }
    catch (error) {
      if (!(error instanceof ComputersApiError) || (error.httpStatus !== 0 && error.httpStatus < 500)) throw error;
      response = await send();
    }
    return (await this.#read(response, computerBody)).computer;
  }

  async rename(id: string, name: string): Promise<Computer> {
    return (await this.#read(await this.#send(`/computers/${computerPath(id)}`, { method: "PATCH", body: JSON.stringify({ name }), headers: JSON_TYPE }), computerBody)).computer;
  }

  /** Synchronous: "deleted" once the service answers, "absent" when it had no such computer. Done either way. */
  async remove(id: string): Promise<"deleted" | "absent"> {
    let response: Response;
    try { response = await this.#send(`/computers/${computerPath(id)}`, { method: "DELETE" }); }
    catch (error) { if (error instanceof ComputersApiError && (error.httpStatus === 404 || error.httpStatus === 410)) return "absent"; throw error; }
    await this.#read(response, z.object({ deleted: z.literal(true) }));
    return "deleted";
  }

  wake(id: string, options: { signal?: AbortSignal } = {}): Promise<Computer> { return this.#lifecycle(id, "wake", options.signal); }
  sleep(id: string): Promise<Computer> { return this.#lifecycle(id, "sleep"); }
  async #lifecycle(id: string, action: "wake" | "sleep", signal?: AbortSignal): Promise<Computer> {
    // A JSON body even when empty: a Worker that reads every POST as JSON must not fail on this one.
    return (await this.#read(await this.#send(`/computers/${computerPath(id)}/${action}`, { method: "POST", body: "{}", headers: JSON_TYPE, timeoutMs: 30_000, signal }), computerBody)).computer;
  }

  /** `command` runs through the computer's shell as its dog user. The service stops it after `timeoutMs`; this request
   * waits a little longer for that answer. 409 `asleep` when the computer is not running. */
  async exec(id: string, input: { command: string; timeoutMs?: number; cwd?: string }, options: { signal?: AbortSignal } = {}): Promise<ExecResult> {
    return this.#read(await this.#send(`/computers/${computerPath(id)}/exec`, { method: "POST", body: JSON.stringify(input), headers: JSON_TYPE,
      timeoutMs: (input.timeoutMs ?? 120_000) + 10_000, signal: options.signal }), execBody);
  }

  async readFile(id: string, path: string, options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<Buffer> {
    const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
    const response = await this.#send(filesPath(id, path), { accept: "application/octet-stream", timeoutMs: 60_000, signal: options.signal });
    return readCapped(response, maxBytes, () => new ComputersApiError(`that file is larger than ${maxBytes} bytes`, 413, "too_large"));
  }

  async writeFile(id: string, path: string, bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<void> {
    const response = await this.#send(filesPath(id, path), { method: "PUT", body: bytes, headers: { "content-type": "application/octet-stream" }, timeoutMs: 60_000, signal: options.signal });
    await response.body?.cancel().catch(() => {});
  }

  /** The whole screen as JPEG with the pointer drawn, at the desktop's native size. 409 `asleep` when not running. */
  async screenshot(id: string, options: { signal?: AbortSignal } = {}): Promise<Buffer> {
    const response = await this.#send(`/computers/${computerPath(id)}/screenshot`, { accept: "image/jpeg", timeoutMs: 30_000, signal: options.signal });
    if (!/^image\/jpeg\b/i.test(response.headers.get("content-type") ?? "")) { await response.body?.cancel().catch(() => {}); throw unexpected("a frame that is not a JPEG image"); }
    const frame = await readCapped(response, MAX_FRAME_BYTES, () => new ComputersApiError("the cloud computer frame exceeds the 8 MB limit", 502, "frame_too_large"));
    if (!frame.length) throw unexpected("an empty frame");
    return frame;
  }

  /** A fresh signed noVNC link for Take control. Never stored: it expires. 409 `asleep` when not running. */
  async desktop(id: string): Promise<{ url: string; expiresAt?: string | number }> {
    const body = await this.#read(await this.#send(`/computers/${computerPath(id)}/desktop`, { method: "POST", body: "{}", headers: JSON_TYPE, timeoutMs: 30_000 }), desktopBody);
    // The desktop viewer opens only HTTPS, or loopback HTTP from a local stub (electron/desktop-viewer.cjs).
    let url: URL | null = null;
    try { url = new URL(body.url); } catch { /* refused below */ }
    if (!url || url.username || url.password || !httpsOrLoopback(url)) throw unexpected("an unusable desktop link");
    return body;
  }

  async trial(): Promise<TrialView | null> {
    let response: Response;
    try { response = await this.#send("/trial", { timeoutMs: 15_000 }); }
    catch (error) { if (error instanceof ComputersApiError && error.httpStatus === 401) return null; throw error; }
    return (await this.#read(response, trialBody)).trial;
  }

  async endTrial(): Promise<void> {
    let response: Response;
    try { response = await this.#send("/trial", { method: "DELETE", timeoutMs: 30_000 }); }
    catch (error) { if (error instanceof ComputersApiError && error.httpStatus === 401) return; throw error; }
    await this.#read(response, z.object({ ended: z.literal(true) }));
  }
}
