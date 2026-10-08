// Validation of API request bodies and query parameters. Pure, so it is unit tested; every failure is a 400 with a code.

import type { Refusal } from "./auth";

export const SIZES = { small: "standard-1", standard: "standard-2", large: "standard-3" } as const;
export type Size = keyof typeof SIZES;

export const EXEC_DEFAULT_TIMEOUT_MS = 120_000;
export const EXEC_MAX_TIMEOUT_MS = 600_000;
export const EXEC_MIN_TIMEOUT_MS = 1_000;
export const COMMAND_MAX_CHARS = 100_000;
export const PATH_MAX_CHARS = 4096;
export const NAME_MAX_CHARS = 64;
export const FILE_MAX_BYTES = 16 * 1024 * 1024;
export const JSON_MAX_BYTES = 1024 * 1024;

export type Parsed<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

const bad = (code: string, message: string): Parsed<never> => ({ ok: false, refusal: { status: 400, code, message } });

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every control character (tab and newline included) is refused in names; NUL is refused everywhere (argv cannot carry it).
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function parseName(raw: unknown): Parsed<string> {
  if (typeof raw !== "string") return bad("invalid_name", "name must be a string.");
  const name = raw.trim();
  if (name.length === 0 || name.length > NAME_MAX_CHARS || CONTROL.test(name)) {
    return bad("invalid_name", `name must be 1 to ${NAME_MAX_CHARS} printable characters.`);
  }
  return { ok: true, value: name };
}

export function parseCreate(body: unknown): Parsed<{ name?: string; size: Size }> {
  if (body === undefined) return { ok: true, value: { size: "standard" } };
  if (!isObject(body)) return bad("invalid_body", "The body must be a JSON object.");
  let name: string | undefined;
  if (body.name !== undefined && body.name !== null) {
    const parsed = parseName(body.name);
    if (!parsed.ok) return parsed;
    name = parsed.value;
  }
  const size = body.size ?? "standard";
  if (typeof size !== "string" || !Object.hasOwn(SIZES, size)) return bad("invalid_size", `size must be one of ${Object.keys(SIZES).join(", ")}.`);
  return { ok: true, value: { ...(name === undefined ? {} : { name }), size: size as Size } };
}

export function parseRename(body: unknown): Parsed<{ name: string }> {
  if (!isObject(body) || body.name === undefined) return bad("invalid_body", 'The body must be a JSON object with a "name".');
  const parsed = parseName(body.name);
  return parsed.ok ? { ok: true, value: { name: parsed.value } } : parsed;
}

export function parsePath(raw: unknown): Parsed<string> {
  if (typeof raw !== "string" || raw.length === 0) return bad("invalid_path", "path is required.");
  if (raw.length > PATH_MAX_CHARS || raw.includes("\u0000")) return bad("invalid_path", `path must be at most ${PATH_MAX_CHARS} characters without NUL.`);
  if (raw.endsWith("/")) return bad("invalid_path", "path must name a file, not a directory.");
  return { ok: true, value: raw };
}

export interface ExecInput {
  command: string;
  timeoutMs: number;
  cwd?: string;
}

export function parseExec(body: unknown): Parsed<ExecInput> {
  if (!isObject(body)) return bad("invalid_body", 'The body must be a JSON object with a "command".');
  const { command, timeoutMs, cwd } = body;
  if (typeof command !== "string" || command.trim().length === 0) return bad("invalid_command", "command must be a non-empty string.");
  if (command.length > COMMAND_MAX_CHARS || command.includes("\u0000")) {
    return bad("invalid_command", `command must be at most ${COMMAND_MAX_CHARS} characters without NUL.`);
  }
  let timeout = EXEC_DEFAULT_TIMEOUT_MS;
  if (timeoutMs !== undefined && timeoutMs !== null) {
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < EXEC_MIN_TIMEOUT_MS || timeoutMs > EXEC_MAX_TIMEOUT_MS) {
      return bad("invalid_timeout", `timeoutMs must be a whole number from ${EXEC_MIN_TIMEOUT_MS} to ${EXEC_MAX_TIMEOUT_MS}.`);
    }
    timeout = timeoutMs;
  }
  const value: ExecInput = { command, timeoutMs: timeout };
  if (cwd !== undefined && cwd !== null) {
    if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > PATH_MAX_CHARS || cwd.includes("\u0000")) {
      return bad("invalid_cwd", `cwd must be a path of 1 to ${PATH_MAX_CHARS} characters.`);
    }
    value.cwd = cwd;
  }
  return { ok: true, value };
}

/** Idempotency-Key header: optional, 1 to 200 visible ASCII characters. */
export function parseIdempotencyKey(raw: string | null): Parsed<string | undefined> {
  if (raw === null) return { ok: true, value: undefined };
  if (!/^[\x21-\x7e]{1,200}$/.test(raw)) return bad("invalid_idempotency_key", "Idempotency-Key must be 1 to 200 visible ASCII characters.");
  return { ok: true, value: raw };
}
