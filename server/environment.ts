import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { SERVER_ROOT } from "./proxy-paths.ts";

export interface EnvironmentDescriptor {
  environmentId: string;
  label: string;
  platform: NodeJS.Platform;
  version: string;
  capabilities: {
    remoteSessions: true;
    sharedComputers?: true;
    cloudHome?: true;
    selfUpdate: "desktop-managed" | "operator";
    emailSignIn?: boolean;
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hasCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function readEnvironmentId(file: string): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw new Error(`Cannot read the existing environment identity at ${file}; refusing to replace it.`, {
      cause: error,
    });
  }

  const id = contents.trim();
  if (!UUID_PATTERN.test(id)) {
    throw new Error(`The existing environment identity at ${file} is not a valid UUID; refusing to replace it.`);
  }
  return id;
}

export function loadEnvironmentId(dataDir: string): string {
  const file = join(dataDir, "environment-id");
  const existing = readEnvironmentId(file);
  if (existing) return existing;

  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const id = randomUUID();
  const temporaryFile = join(directory, `.environment-id.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;

  try {
    descriptor = openSync(temporaryFile, "wx", 0o600);
    writeFileSync(descriptor, id + "\n", "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    try {
      linkSync(temporaryFile, file);
      return id;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const winner = readEnvironmentId(file);
      if (winner) return winner;
      throw new Error(`The environment identity at ${file} disappeared while it was being created.`);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryFile);
    } catch {}
  }
}

export function serverVersion(): string {
  const fromEnv = process.env.LATERDOG_APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(SERVER_ROOT, "..", "package.json"), "utf8"));
    const version = Reflect.get(Object(pkg), "version");
    if (typeof version === "string" && version) return version;
  } catch {}
  return "unknown";
}

export function environmentDescriptor(input: { environmentId: string; desktopManaged: boolean; emailSignIn?: boolean; sharedComputers?: boolean; cloudHome?: boolean }): EnvironmentDescriptor {
  return {
    environmentId: input.environmentId,
    label: process.env.LATERDOG_ENVIRONMENT_LABEL?.trim() || hostname(),
    platform: process.platform,
    version: serverVersion(),
    capabilities: {
      remoteSessions: true,
      ...(input.sharedComputers === true ? { sharedComputers: true as const } : {}),
      ...(input.cloudHome === true ? { cloudHome: true as const } : {}),
      selfUpdate: input.desktopManaged ? "desktop-managed" : "operator",
      emailSignIn: input.emailSignIn === true,
    },
  };
}
