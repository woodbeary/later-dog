import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";

export const configSchema = z.object({
  profiles: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), label: z.string().min(1).max(100),
    backend: z.enum(["codex-cloud", "claude-cloud"]).default("codex-cloud"),
    codexHome: z.string().refine(isAbsolute, "codexHome must be absolute").optional(), cli: z.string().min(1).optional(),
    routineId: z.string().regex(/^trig_[A-Za-z0-9_-]+$/, "routineId must look like trig_…").optional(),
    routineTokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "routineTokenEnv must be an environment variable name").optional() }).strict()
    .refine((p) => p.backend !== "claude-cloud" || p.routineTokenEnv, "A claude-cloud profile needs routineTokenEnv")).min(1)
    .default([{ id: "default", label: "My Codex subscription", backend: "codex-cloud" }]).refine((p) => new Set(p.map((x) => x.id)).size === p.length, "Profile IDs must be unique"),
  concurrency: z.number().int().min(1).max(100).default(4),
  pollIntervalMs: z.number().int().min(0).max(600_000).default(30_000),
  publishingHost: z.enum(["local", "remote"]).default("local"),
  workspaceUrl: z.string().url().optional(),
  workspaceTokenFile: z.string().refine(isAbsolute).optional(),
}).strict();
export function supervisorDataDir(): string { return process.env.LATERDOG_DATA_DIR ?? join(process.env.LATERDOG_HOME ?? join(homedir(), ".laterdog"), "supervisor"); }
export function supervisorToken(dataDir = supervisorDataDir()): string {
  // Secrets pasted into a hosting platform often carry a trailing newline; an untrimmed token would reject every call with 401.
  if (process.env.LATERDOG_TOKEN?.trim()) return process.env.LATERDOG_TOKEN.trim();
  const file = process.env.LATERDOG_TOKEN_FILE ?? join(dataDir,"access-token");
  if (existsSync(file)) return readFileSync(file,"utf8").trim();
  mkdirSync(dirname(file),{ recursive: true, mode: 0o700 }); const token = randomBytes(32).toString("base64url");
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary,token,{ mode: 0o600, flag: "wx" });
  try { linkSync(temporary,file); return token; }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return readFileSync(file,"utf8").trim(); throw error; }
  finally { unlinkSync(temporary); }
}
export function loadSupervisorConfig(dataDir = supervisorDataDir()) {
  const file = join(dataDir,"config.json");
  return configSchema.parse({ ...(existsSync(file) ? JSON.parse(readFileSync(file,"utf8")) as Record<string,unknown> : {}),
    ...(process.env.LATERDOG_WORKSPACE_URL ? { workspaceUrl: process.env.LATERDOG_WORKSPACE_URL } : {}),
    ...(process.env.LATERDOG_PUBLISHING_HOST ? { publishingHost: process.env.LATERDOG_PUBLISHING_HOST } : {}) });
}
function validOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1","localhost","[::1]"].includes(url.hostname)))) throw new Error("Use a credential-free HTTPS supervisor origin, or loopback HTTP");
  return url.origin;
}
export const connectionSchema = z.object({ url: z.string().url(), tokenFile: z.string().min(1).transform((file) => file.replace(/^~(?=\/)/, homedir()))
  .refine(isAbsolute, "tokenFile must be an absolute path") }).strict();
export interface SupervisorConnection { origin: string; tokenFile?: string; source: "environment" | "file" | "local" }
/** `<data>/supervisor.json`, beside the local supervisor's own `supervisor/` directory: `{ "url": "https://…", "tokenFile": "/abs/path" }`. */
export function supervisorConnectionFile(): string { return join(process.env.LATERDOG_HOME ?? join(homedir(), ".laterdog"), "supervisor.json"); }
/** Which supervisor this desktop's workspace, proxy and bots talk to. `LATERDOG_SUPERVISOR_URL` wins; then the saved connection file, so a
 * packaged app launched from Finder reaches a hosted supervisor; otherwise the local supervisor the desktop starts itself. */
export function supervisorConnection(): SupervisorConnection {
  if (process.env.LATERDOG_SUPERVISOR_URL) {
    return { origin: validOrigin(process.env.LATERDOG_SUPERVISOR_URL), ...(process.env.LATERDOG_TOKEN_FILE ? { tokenFile: process.env.LATERDOG_TOKEN_FILE } : {}), source: "environment" };
  }
  const file = supervisorConnectionFile();
  if (existsSync(file)) {
    const saved = connectionSchema.parse(JSON.parse(readFileSync(file,"utf8")));
    return { origin: validOrigin(saved.url), tokenFile: saved.tokenFile, source: "file" };
  }
  return { origin: "http://127.0.0.1:9010", source: "local" };
}
export function supervisorOrigin(): string { return supervisorConnection().origin; }
/** The bearer this desktop presents. A hosted connection must name an existing token file: generating one here would only produce 401s. */
export function desktopSupervisorToken(): string {
  if (process.env.LATERDOG_TOKEN?.trim()) return process.env.LATERDOG_TOKEN.trim();
  const connection = supervisorConnection();
  if (connection.source === "local") return supervisorToken();
  if (!connection.tokenFile) throw new Error(`Set LATERDOG_TOKEN or LATERDOG_TOKEN_FILE for the supervisor at ${connection.origin}`);
  if (!existsSync(connection.tokenFile)) throw new Error(`The supervisor token file ${connection.tokenFile} does not exist`);
  return readFileSync(connection.tokenFile,"utf8").trim();
}
