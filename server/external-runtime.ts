import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
type RuntimeBot = { id: string; hidden?: boolean; tasks?: Array<{ threadId: string; archivedAt?: number }> };
type BotLookup = (id: string) => RuntimeBot | null | undefined;
type Registration = { botId: string; tokenHash: string; threadId: string };
export type ExternalRuntimeGrant = { botId: string; threadId: string; tokenHash: string };
const MAX_FILE_BYTES = 1_048_576;
const ID = /^[\w-]{1,128}$/;
const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex");
const sameFingerprint = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

function registrations(file: string): Registration[] {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return [];
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      console.warn("[comms] ignoring external runtime credentials: use a private file (chmod 600)");
      return [];
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    for (;;) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
      if (count > stat.size) return [];
    }
    const parsed: unknown = JSON.parse(bytes.subarray(0, count).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed).flatMap(([botId, value]) => {
      if (!ID.test(botId) || !value || typeof value !== "object" || Array.isArray(value)) return [];
      const { token, threadId } = value as { token?: unknown; threadId?: unknown };
      if (typeof token !== "string" || token.length < 32 || token.length > 4096 || /\s/.test(token)) return [];
      if (typeof threadId !== "string" || !ID.test(threadId)) return [];
      return [{ botId, tokenHash: fingerprint(token), threadId }];
    });
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function resolveRegistration(file: string, tokenHash: string, botForId: BotLookup): ExternalRuntimeGrant | null {
  const matches = registrations(file).filter(entry => sameFingerprint(entry.tokenHash, tokenHash));
  if (matches.length !== 1) return null;
  const registration = matches[0];
  const bot = botForId(registration.botId);
  if (!bot || bot.hidden) return null;
  const task = bot.tasks?.find(candidate => candidate.threadId === registration.threadId);
  if (!task || task.archivedAt !== undefined) return null;
  return { botId: bot.id, threadId: task.threadId, tokenHash };
}

export function authorizeExternalRuntime(file: string, header: string | string[] | undefined, botForId: BotLookup): ExternalRuntimeGrant | null {
  if (typeof header !== "string" || !/^Bearer \S{32,4096}$/.test(header)) return null;
  return resolveRegistration(file, fingerprint(header.slice(7)), botForId);
}

export function externalRuntimeIsActive(file: string, grant: ExternalRuntimeGrant, botForId: BotLookup): boolean {
  const current = resolveRegistration(file, grant.tokenHash, botForId);
  return current?.botId === grant.botId && current.threadId === grant.threadId;
}
