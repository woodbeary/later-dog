import { createHash } from "node:crypto";
import { z } from "zod";

export type AiAccountKind = "claude" | "codex";

export const MOVABLE_ACCOUNT_ID = /^(?:claude|codex|claude-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const HANDOFF_BODY_LIMIT = 64 * 1024;

export const accountKindOf = (instanceId: string): AiAccountKind => (instanceId === "codex" ? "codex" : "claude");

const secret = z.string().min(1).max(16_384);
const label = z.string().max(200).nullable().optional();

export const claudeLoginSchema = z.object({
  accessToken: secret,
  refreshToken: secret,
  expiresAt: z.number().finite().nonnegative(),
  refreshTokenExpiresAt: z.number().finite().nonnegative().nullable().optional(),
  scopes: z.array(z.string().max(200)).max(50),
  subscriptionType: label,
  rateLimitTier: label,
  clientId: label,
}).passthrough();

export const codexLoginSchema = z.object({
  auth_mode: label,
  OPENAI_API_KEY: z.string().max(16_384).nullable().optional(),
  tokens: z.object({
    id_token: secret,
    access_token: secret,
    refresh_token: secret,
    account_id: label,
  }).passthrough(),
  last_refresh: label,
}).passthrough();

export type ClaudeLogin = z.infer<typeof claudeLoginSchema>;
export type CodexLogin = z.infer<typeof codexLoginSchema>;

export const DEVICE_ID = /^[0-9a-f]{32}$/;
const deviceId = z.string().regex(DEVICE_ID);
const displayName = z.string().trim().min(1).max(80).refine((value) => !/\p{Cc}/u.test(value));

export const handoffSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("claude"), displayName, deviceId, login: claudeLoginSchema }).strict(),
  z.object({ kind: z.literal("codex"), displayName, deviceId, login: codexLoginSchema }).strict(),
]);

export type Handoff = z.infer<typeof handoffSchema>;

export function refreshTokenOf(kind: AiAccountKind, login: ClaudeLogin | CodexLogin): string {
  return kind === "claude" ? (login as ClaudeLogin).refreshToken : (login as CodexLogin).tokens.refresh_token;
}

export function loginFingerprint(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex").slice(0, 16);
}

export function providerAccountOf(kind: AiAccountKind, login: ClaudeLogin | CodexLogin): string | null {
  if (kind !== "codex") return null;
  const id = (login as CodexLogin).tokens.account_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
