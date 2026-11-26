import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { codexHome } from "../drivers/codex-identity.ts";
import { userHome } from "../env-path.ts";
import type { KeptSignIn } from "./account-keeper.ts";
import { currentGrokLogin } from "./guest-grok-login.ts";

export const RENEW_WHEN_LEFT_MS = 15 * 60_000;
const GROK_ISSUER = /^https:\/\/(?:auth\.x\.ai(?:::[a-zA-Z0-9-]+)?|accounts\.x\.ai\/sign-in)$/;

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const seconds = (value: unknown): number => typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : typeof value === "string" ? Date.parse(value) : NaN;

async function json(file: string): Promise<Record<string, unknown> | null> {
  try { return record(JSON.parse(await readFile(file, "utf8"))); } catch { return null; }
}

export function jwtExpiry(token: string): number | null {
  try {
    const exp = record(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch { return null; }
}

type Saved = { kind: "none" } | { kind: "key" } | { kind: "token"; expiresAt: number; refreshable: boolean };

export interface SignInKeep {
  read(): Promise<Saved>;
  renew(): Promise<void>;
  now?: () => number;
  leftMs?: number;
}

export async function keepSignIn({ read, renew, now = Date.now, leftMs = RENEW_WHEN_LEFT_MS }: SignInKeep): Promise<KeptSignIn> {
  const before = await read();
  if (before.kind === "none") return "signed-out";
  if (before.kind === "key" || before.expiresAt - now() > leftMs) return "fresh";
  if (!before.refreshable) return before.expiresAt > now() ? "fresh" : "signed-out";
  await renew().catch(() => {});
  const after = await read();
  if (after.kind === "none" || (after.kind === "token" && !after.refreshable)) return "signed-out";
  if (after.kind === "key" || after.expiresAt > before.expiresAt) return "renewed";
  return "unrenewed";
}

export function codexSignIn(env: Record<string, string | undefined>, renew: () => Promise<unknown>): SignInKeep {
  const home = codexHome(env);
  return {
    async read() {
      const auth = home ? await json(join(home, "auth.json")) : null;
      if (!auth) return { kind: "key" };
      if (text(auth.OPENAI_API_KEY) && auth.auth_mode !== "chatgpt") return { kind: "key" };
      const tokens = record(auth.tokens);
      if (!text(tokens.access_token)) return { kind: "none" };
      const expiresAt = jwtExpiry(tokens.access_token);
      return expiresAt === null ? { kind: "key" } : { kind: "token", expiresAt, refreshable: text(tokens.refresh_token) };
    },
    async renew() { await renew(); },
  };
}

export function grokSignIn(cli: string | undefined, environment: Record<string, string>, now: () => number = Date.now): SignInKeep {
  const file = join(environment.GROK_HOME || join(userHome(environment), ".grok"), "auth.json");
  return {
    async read() {
      const saved = await json(file);
      if (!saved) return { kind: "key" };
      const entries = Object.entries(saved ?? {}).filter(([issuer, value]) => GROK_ISSUER.test(issuer) && text(record(value).key));
      if (entries.length !== 1) return { kind: "none" };
      const value = record(entries[0]![1]);
      const expiresAt = value.expires_at === undefined ? Infinity : seconds(value.expires_at);
      return Number.isFinite(expiresAt) || expiresAt === Infinity ? { kind: "token", expiresAt, refreshable: text(value.refresh_token) } : { kind: "none" };
    },
    async renew() { if (cli) await currentGrokLogin(file, cli, now() + RENEW_WHEN_LEFT_MS); },
  };
}
