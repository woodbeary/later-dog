import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOCAL_TOOLS_HEADER = "X-LaterDog-Local-Tools";
export const LOCAL_CONTROL_TOKEN_FILE = "local-control-token";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function localControlTokenPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const explicit = env.LATERDOG_LOCAL_CONTROL_TOKEN_FILE?.trim();
  if (explicit) return explicit;
  const appData = platform === "darwin" ? join(home, "Library", "Application Support")
    : platform === "win32" ? env.APPDATA || join(home, "AppData", "Roaming")
    : env.XDG_CONFIG_HOME || join(home, ".config");
  return join(appData, "later.dog", LOCAL_CONTROL_TOKEN_FILE);
}

export interface TokenFileChecks {
  uid?: number;
  platform?: NodeJS.Platform;
}

export function readLocalControlToken(file: string = localControlTokenPath(), checks: TokenFileChecks = {}): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile()) return undefined;
    if ((checks.platform ?? process.platform) !== "win32") {
      const uid = "uid" in checks ? checks.uid : process.getuid?.();
      if (uid !== undefined && info.uid !== uid) return undefined;
      if ((info.mode & 0o077) !== 0) return undefined;
    }
    const token = readFileSync(fd, "utf8").trim();
    return TOKEN.test(token) ? token : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

export function localToolsHeaders(url: string, env: NodeJS.ProcessEnv = process.env, checks: TokenFileChecks = {}): Record<string, string> {
  if (env.LATERDOG_SERVER_TOKEN?.trim() || !isLoopbackUrl(url)) return {};
  const token = readLocalControlToken(localControlTokenPath(env), checks);
  return token ? { [LOCAL_TOOLS_HEADER]: token } : {};
}

export function withLocalTools(options: RequestInit, url: string, env: NodeJS.ProcessEnv = process.env): RequestInit {
  const headers = new Headers(options.headers);
  for (const [name, value] of Object.entries(localToolsHeaders(url, env))) if (!headers.has(name)) headers.set(name, value);
  return { ...options, headers };
}
