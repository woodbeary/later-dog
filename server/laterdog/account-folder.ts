import { lstatSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { configuredAccountDirectory } from "../claude-accounts.ts";
import type { InstanceConfig } from "../contracts.ts";

const ACCOUNT_ID = /^[A-Za-z0-9][\w.-]{0,127}$/;

function directoryIn(entry: InstanceConfig): string | null {
  if (entry.driver === "codex") {
    const home = entry.environment?.CODEX_HOME;
    return typeof home === "string" && home ? resolve(home) : null;
  }
  if (entry.driver !== "claudeAgent") return null;
  try {
    const directory = configuredAccountDirectory(entry);
    return directory ? resolve(directory) : null;
  } catch {
    return null;
  }
}

export function ownedAccountFolder(dataDir: string, instanceId: string, entry: InstanceConfig | undefined): string | null {
  if (!entry || !ACCOUNT_ID.test(instanceId) || instanceId.includes("..")) return null;
  const folder = resolve(join(dataDir, "providers", instanceId));
  return directoryIn(entry) === folder ? folder : null;
}

export function forgetAccountFolder(dataDir: string, instanceId: string, entry: InstanceConfig | undefined): boolean {
  const folder = ownedAccountFolder(dataDir, instanceId, entry);
  if (!folder) return false;
  try {
    lstatSync(folder);
    rmSync(folder, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
