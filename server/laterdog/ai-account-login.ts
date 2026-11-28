import { createHash } from "node:crypto";
import { z } from "zod";

export type AiAccountKind = "claude" | "codex" | "antigravity";

export const MOVABLE_ACCOUNT_ID = /^(?:claude|codex|antigravity|claude-\d{1,4}|(?:claude|antigravity)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const HANDOFF_BODY_LIMIT = 64 * 1024;

export const accountKindOf = (instanceId: string): AiAccountKind =>
  instanceId === "codex" ? "codex" : instanceId === "antigravity" || instanceId.startsWith("antigravity-") ? "antigravity" : "claude";

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

export const antigravityLoginSchema = z.object({
  token: z.object({
    access_token: secret,
    refresh_token: secret,
    token_type: label,
    expiry: label,
    expires_in: z.number().finite().optional(),
  }).passthrough(),
  auth_method: label,
  id_token_email: label,
}).passthrough();

export type ClaudeLogin = z.infer<typeof claudeLoginSchema>;
export type AntigravityLogin = z.infer<typeof antigravityLoginSchema>;
export type CodexLogin = z.infer<typeof codexLoginSchema>;

export const DEVICE_ID = /^[0-9a-f]{32}$/;
const deviceId = z.string().regex(DEVICE_ID);
const displayName = z.string().trim().min(1).max(80).refine((value) => !/\p{Cc}/u.test(value));

export const accountEmailSchema = z.string().trim().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));

export const handoffSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("claude"), displayName, deviceId, login: claudeLoginSchema, email: accountEmailSchema.optional() }).strict(),
  z.object({ kind: z.literal("codex"), displayName, deviceId, login: codexLoginSchema, email: accountEmailSchema.optional() }).strict(),
  z.object({ kind: z.literal("antigravity"), displayName, deviceId, login: antigravityLoginSchema, email: accountEmailSchema.optional() }).strict(),
]);

export type Handoff = z.infer<typeof handoffSchema>;

export type AnyLogin = ClaudeLogin | CodexLogin | AntigravityLogin;

export function refreshTokenOf(kind: AiAccountKind, login: AnyLogin): string {
  if (kind === "antigravity") return (login as AntigravityLogin).token.refresh_token;
  return kind === "claude" ? (login as ClaudeLogin).refreshToken : (login as CodexLogin).tokens.refresh_token;
}

export function loginFingerprint(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex").slice(0, 16);
}

export function providerAccountOf(kind: AiAccountKind, login: AnyLogin, email?: string): string | null {
  if (kind !== "codex") return email ? `email:${email.toLowerCase()}` : null;
  const id = (login as CodexLogin).tokens.account_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
