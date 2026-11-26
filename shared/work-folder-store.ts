export const WORK_FOLDER_BLOB_BYTES = 8 * 1024 * 1024;
export const WORK_FOLDER_PAGE_SIZE = 64;
export const WORK_FOLDER_ROUTE = "/api/work-folders/v1/";
export const WORK_FOLDER_ACCESS_MS = 15 * 60_000;

export type WorkFolderEntry = (
  | { path: string; kind: "dir"; mode: number }
  | { path: string; kind: "link"; target: string; mode?: number; scopedTarget?: string | null }
  | { path: string; kind: "file"; mode: number; size: number; sha256: string; contents: string }
) & { mtimeMs?: number };

export type WorkFolderNode =
  | { v: 1; kind: "chunks"; hashes: string[] }
  | { v: 1; kind: "entries"; entries: WorkFolderEntry[] }
  | { v: 1; kind: "pages"; of: "entries" | "chunks"; children: string[] }
  | { v: 1; kind: "root"; mode: number; entries: string; mtimeMs?: number };

export interface WorkFolderHead {
  revision: string;
  parent: string | null;
  manifest: string | null;
  state: "live" | "tombstone";
}

export interface WorkFolderGrant {
  baseUrl: string;
  guestId: string;
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
}

export interface WorkFolderPageInfo {
  of: "entries" | "chunks" | "root";
  count: number;
  bytes: number;
  first?: string;
  last?: string;
}

const scopeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const utf8 = new TextEncoder();

export function validWorkFolderScope(botId: string, folderId: string): boolean {
  return scopeId.test(botId) && scopeId.test(folderId);
}

export function workFolderBaseUrl(origin: string, botId: string, folderId: string): string {
  if (!validWorkFolderScope(botId, folderId)) throw new Error("Invalid work folder scope");
  return new URL(WORK_FOLDER_ROUTE + botId + "/" + folderId, origin).href;
}

export async function workFolderAuthority(bootstrapSecret: string, botId: string, folderId: string): Promise<string> {
  if (!bootstrapSecret || !validWorkFolderScope(botId, folderId)) throw new Error("Invalid work folder authority");
  const key = await crypto.subtle.importKey("raw", utf8.encode(bootstrapSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8.encode("laterdog-work-folder-v1\n" + botId + "\n" + folderId)));
  return "wfa_" + Array.from(mac, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function compareWorkFolderPaths(a: string, b: string): number {
  const left = utf8.encode(a), right = utf8.encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const delta = left[i]! - right[i]!;
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}

export function safeWorkFolderPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !/[\uD800-\uDFFF]/u.test(path) && !path.includes("\0") && path.split("/").every(part => part && part !== "." && part !== "..");
}

export function safeWorkFolderLink(path: string, target: unknown): target is string {
  if (typeof target !== "string" || !target || target.startsWith("/") || target.includes("\0")) return false;
  let depth = path.split("/").length - 1;
  for (const part of target.split("/")) {
    if (part === "..") { if (--depth < 0) return false; }
    else if (part && part !== ".") depth++;
  }
  return true;
}

export function materializedWorkFolderLink(entry: Extract<WorkFolderEntry, { kind: "link" }>): string {
  if (!safeWorkFolderPath(entry.path) || !entry.target || entry.target.includes("\0")) throw new Error("Invalid working folder link");
  if (entry.scopedTarget === null) return entry.path.slice(entry.path.lastIndexOf("/") + 1);
  const target = entry.scopedTarget ?? entry.target;
  if (!safeWorkFolderLink(entry.path, target)) throw new Error("Working folder link escapes its scope");
  return target;
}
