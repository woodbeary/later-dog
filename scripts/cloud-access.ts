import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { localControlTokenPath, type TokenFileChecks } from "./local-control-token.ts";

export const CLOUD_ACCESS_FILE = "cloud-access.json";
const SESSION = /^laterdog_sess_[A-Za-z0-9_-]+$/;

export interface CloudAccess {
  url: string;
  token: string;
}

export function cloudAccessPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home?: string): string {
  return join(dirname(home === undefined ? localControlTokenPath(env, platform) : localControlTokenPath(env, platform, home)), CLOUD_ACCESS_FILE);
}

export function readCloudAccess(file: string = cloudAccessPath(), checks: TokenFileChecks = {}): CloudAccess | undefined {
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
    const value = JSON.parse(readFileSync(fd, "utf8")) as Partial<CloudAccess>;
    if (typeof value.url !== "string" || typeof value.token !== "string" || !SESSION.test(value.token)) return undefined;
    const origin = new URL(value.url);
    return origin.protocol === "https:" && origin.origin === value.url ? { url: value.url, token: value.token } : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
