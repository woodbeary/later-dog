type Failure = { status?: unknown; code?: unknown; errcode?: unknown; errstr?: unknown; message?: unknown };

export interface PlainFailure {
  status: number;
  message: string;
  internal: boolean;
}

const OUT_OF_SPACE_CODES = new Set(["ENOSPC", "EDQUOT"]);
const NOT_ALLOWED_CODES = new Set(["EACCES", "EPERM", "EROFS"]);
const SQLITE_FULL = 13;
const OUT_OF_SPACE_WORDS = /no space left|database or disk is full|disk (?:is )?full|quota exceeded/i;
const STACK_LINE = /\n\s+at\s|\bat\s+\S+\s+\(\S+:\d+:\d+\)/;
const DATABASE_WORDS = /\bsqlite\b|\bsqlite_\w+|cannot rollback|no transaction is active|database is locked|database disk image|constraint failed/i;
const BYTE_LIMIT = /^(file|image|audio) exceeds (\d+) bytes$/;
const FALLBACK = "Something went wrong on this computer, so that didn't go through. Try again, and if it keeps happening, quit and reopen later.dog.";

function thisComputer(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Your Mac";
  if (platform === "win32") return "Your PC";
  return "This computer";
}

function megabytes(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function tooBigMessage(kind: "file" | "image" | "audio", bytes: number): string {
  return `That ${kind === "image" ? "picture" : kind} is bigger than ${megabytes(bytes)} MB, which is the most later.dog takes. Try a smaller one.`;
}

function checkedFields(raw: string): string | null {
  if (!raw.startsWith("[")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const lines: string[] = [];
  for (const issue of parsed) {
    const found = issue as { path?: unknown; message?: unknown };
    if (!found || typeof found.message !== "string" || !Array.isArray(found.path)) return null;
    const field = found.path.map(String).join(".");
    lines.push(field ? `${field}: ${found.message}` : found.message);
  }
  return lines.slice(0, 3).join("; ");
}

function isOutOfSpace(failure: Failure, message: string): boolean {
  return (typeof failure.code === "string" && OUT_OF_SPACE_CODES.has(failure.code))
    || failure.errcode === SQLITE_FULL
    || OUT_OF_SPACE_WORDS.test(message)
    || (typeof failure.errstr === "string" && OUT_OF_SPACE_WORDS.test(failure.errstr));
}

function looksInternal(error: unknown, failure: Failure, message: string): boolean {
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError || error instanceof SyntaxError) return true;
  if (typeof failure.code === "string" && /^(?:E[A-Z0-9]+|ERR_[A-Z0-9_]+)$/.test(failure.code)) return true;
  if (typeof failure.errcode === "number") return true;
  return STACK_LINE.test(message) || DATABASE_WORDS.test(message);
}

export function isStorageFailure(error: unknown): boolean {
  const failure = (error && typeof error === "object" ? error : {}) as Failure;
  const message = error instanceof Error ? error.message : "";
  return (typeof failure.code === "string" && (OUT_OF_SPACE_CODES.has(failure.code) || NOT_ALLOWED_CODES.has(failure.code) || failure.code === "EIO"))
    || typeof failure.errcode === "number"
    || OUT_OF_SPACE_WORDS.test(message);
}

export function plainFailure(error: unknown, platform: NodeJS.Platform = process.platform): PlainFailure {
  const failure = (error && typeof error === "object" ? error : {}) as Failure;
  const raw = error instanceof Error ? error.message : typeof failure.message === "string" ? failure.message : String(error);
  const status = typeof failure.status === "number" ? failure.status : 500;
  const limit = BYTE_LIMIT.exec(raw);
  if (limit) {
    return { status, internal: false, message: tooBigMessage(limit[1] as "file" | "image" | "audio", Number(limit[2])) };
  }
  if (isOutOfSpace(failure, raw)) {
    return { status, internal: true, message: `${thisComputer(platform)} is almost out of space, so later.dog couldn't save that. Free up some space and try again.` };
  }
  if (typeof failure.code === "string" && NOT_ALLOWED_CODES.has(failure.code)) {
    return { status, internal: true, message: "later.dog isn't allowed to write to its data folder, so it couldn't save that. Check that folder's permissions and try again." };
  }
  const fields = checkedFields(raw);
  if (fields) return { status, internal: false, message: `That wasn't something later.dog could use (${fields}). Check it and try again.` };
  if (typeof failure.status === "number" && failure.status < 500) return { status, internal: false, message: raw };
  if (looksInternal(error, failure, raw)) return { status, internal: true, message: FALLBACK };
  return { status, internal: false, message: raw };
}
