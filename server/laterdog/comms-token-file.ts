import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomicIfChanged } from "../atomic.ts";

export const COMMS_TOKEN_ENV = "LATERDOG_COMMS_TOKEN";
export const COMMS_TOKEN_FILE_ENV = "LATERDOG_COMMS_TOKEN_FILE";

export interface TurnCommsToken {
  file: string;
  token: string;
}

export function commsTokenFile(dataDir: string, threadId: string, botId?: string): string {
  const digest = createHash("sha256").update(`${botId ?? ""}\0${threadId}`).digest("hex").slice(0, 24);
  return join(dataDir, "comms-tokens", `${digest}.token`);
}

export function commsTokenByFile<T extends { env?: Record<string, string> }>(server: T, file: string): { server: T; token: TurnCommsToken | null } {
  const token = server.env?.[COMMS_TOKEN_ENV];
  if (!token) return { server, token: null };
  const env: Record<string, string> = { ...server.env, [COMMS_TOKEN_FILE_ENV]: file };
  delete env[COMMS_TOKEN_ENV];
  return { server: { ...server, env }, token: { file, token } };
}

export function writeTurnCommsToken(token: TurnCommsToken | null): void {
  if (!token) return;
  mkdirSync(dirname(token.file), { recursive: true, mode: 0o700 });
  writeFileAtomicIfChanged(token.file, token.token, { mode: 0o600, durable: false });
}

export function commsTokenFromEnv(env: NodeJS.ProcessEnv): () => string {
  const file = env[COMMS_TOKEN_FILE_ENV];
  if (!file) {
    const token = env[COMMS_TOKEN_ENV] ?? "";
    return () => token;
  }
  return () => {
    try { return readFileSync(file, "utf8").trim(); } catch { return ""; }
  };
}
