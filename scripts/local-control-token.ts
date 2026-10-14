import { readFileSync, statSync } from "node:fs";
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

export function readLocalControlToken(file: string = localControlTokenPath()): string | undefined {
  try {
    if (!statSync(file).isFile()) return undefined;
    const token = readFileSync(file, "utf8").trim();
    return TOKEN.test(token) ? token : undefined;
  } catch {
    return undefined;
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

export function localToolsHeaders(url: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (env.LATERDOG_SERVER_TOKEN?.trim() || !isLoopbackUrl(url)) return {};
  const token = readLocalControlToken(localControlTokenPath(env));
  return token ? { [LOCAL_TOOLS_HEADER]: token } : {};
}
