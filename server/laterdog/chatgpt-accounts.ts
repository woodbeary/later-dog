import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import type { InstanceConfig, InstanceConfigMap } from "../contracts.ts";

export const CODEX_FILE_STORE = "cli_auth_credentials_store = \"file\"\n";

export interface NewChatGptAccountOptions {
  cloudHome: boolean;
  dataDir: string;
  newId?: () => string;
}

const cliOf = (entry: InstanceConfig | undefined): string | undefined => {
  const cli = (entry?.config as { cli?: unknown } | undefined)?.cli;
  return typeof cli === "string" && cli ? cli : undefined;
};

export function prepareCodexHome(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("account folder is not a plain folder");
  chmodSync(directory, 0o700);
  const config = join(directory, "config.toml");
  if (!existsSync(config)) writeFileAtomic(config, CODEX_FILE_STORE, { mode: 0o600 });
}

export function newChatGptAccount(current: InstanceConfigMap, displayName: string, options: NewChatGptAccountOptions): { instanceId: string; instances: InstanceConfigMap } {
  const instances = { ...current };
  const cli = cliOf(instances.chatgpt) ?? cliOf(instances.codex);
  const id = (options.newId ?? randomUUID)();
  if (!options.cloudHome) {
    const instanceId = `chatgpt-${id}`;
    instances[instanceId] = { driver: "codex", displayName, config: { authMode: "chatgpt-plan", ...(cli ? { cli } : {}) } };
    return { instanceId, instances };
  }
  const instanceId = `codex-${id}`;
  const directory = join(options.dataDir, "providers", instanceId);
  prepareCodexHome(directory);
  instances[instanceId] = { driver: "codex", displayName, environment: { CODEX_HOME: directory }, ...(cli ? { config: { cli } } : {}) };
  return { instanceId, instances };
}
