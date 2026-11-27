export const SIGNED_CAPABILITY_PREFIX = "ldc1.";
export const CAPABILITY_KEY_LABEL = "laterdog-home:capability:v1";
export const signedCapabilityKinds = ["agents", "connectors", "computer", "browser", "hooks", "turns", "index"] as const;
export type SignedCapabilityKind = (typeof signedCapabilityKinds)[number];

export interface SignedCapabilityClaims {
  home: string;
  dog: string;
  chat: string;
  generation: string;
  kind: SignedCapabilityKind;
  issuedAt: number;
  expiresAt: number;
}

export type CapabilityRefusal = "malformed" | "forged" | "expired" | "wrong-home" | "wrong-kind";
export type CapabilityCheck = { ok: true; claims: SignedCapabilityClaims } | { ok: false; reason: CapabilityRefusal };
export interface CapabilityExpectation {
  home: string;
  now: number;
  kinds?: readonly SignedCapabilityKind[];
}

const MAX_TOKEN_LENGTH = 2048;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function validKind(kind: unknown): kind is SignedCapabilityKind {
  return typeof kind === "string" && (signedCapabilityKinds as readonly string[]).includes(kind);
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function validCapabilityClaims(value: unknown): value is SignedCapabilityClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as Record<string, unknown>;
  return ["home", "dog", "chat", "generation"].every((field) => typeof claims[field] === "string" && IDENTIFIER.test(claims[field] as string)) &&
    validKind(claims.kind) && validTime(claims.issuedAt) && validTime(claims.expiresAt) &&
    (claims.expiresAt as number) > (claims.issuedAt as number);
}

export function encodeCapabilityPayload(claims: SignedCapabilityClaims): string {
  if (!validCapabilityClaims(claims)) throw new Error("invalid capability claims");
  const { home, dog, chat, generation, kind, issuedAt, expiresAt } = claims;
  return base64urlEncode(encoder.encode(JSON.stringify({ v: 1, h: home, d: dog, c: chat, g: generation, k: kind, i: issuedAt, e: expiresAt })));
}

export interface CapabilityParts {
  signed: string;
  mac: Uint8Array<ArrayBuffer>;
  claims: SignedCapabilityClaims;
}

export function capabilityParts(token: string): CapabilityParts | null {
  if (token.length > MAX_TOKEN_LENGTH || !token.startsWith(SIGNED_CAPABILITY_PREFIX)) return null;
  const [payload, mac, extra] = token.slice(SIGNED_CAPABILITY_PREFIX.length).split(".");
  if (!payload || !mac || extra !== undefined) return null;
  const macBytes = base64urlDecode(mac);
  const payloadBytes = base64urlDecode(payload);
  if (!macBytes || macBytes.length !== 32 || !payloadBytes) return null;
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object" || decoded.v !== 1) return null;
  const claims = { home: decoded.h, dog: decoded.d, chat: decoded.c, generation: decoded.g, kind: decoded.k, issuedAt: decoded.i, expiresAt: decoded.e };
  if (!validCapabilityClaims(claims)) return null;
  return { signed: `${SIGNED_CAPABILITY_PREFIX}${payload}`, mac: macBytes, claims };
}

export function admitCapability(claims: SignedCapabilityClaims, expect: CapabilityExpectation): CapabilityCheck {
  if (claims.home !== expect.home) return { ok: false, reason: "wrong-home" };
  if (claims.expiresAt <= expect.now) return { ok: false, reason: "expired" };
  if (expect.kinds && !expect.kinds.includes(claims.kind)) return { ok: false, reason: "wrong-kind" };
  return { ok: true, claims };
}

export function isSignedCapability(token: string): boolean {
  return token.startsWith(SIGNED_CAPABILITY_PREFIX);
}

export function bearerCapability(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match && isSignedCapability(match[1]) ? match[1] : null;
}

async function hmacKey(raw: Uint8Array<ArrayBuffer>, usages: Array<"sign" | "verify">): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, usages);
}

export async function capabilityKey(bootstrapSecret: string): Promise<CryptoKey> {
  if (!bootstrapSecret) throw new Error("missing capability secret");
  const parent = await hmacKey(new Uint8Array(encoder.encode(bootstrapSecret)), ["sign"]);
  const raw = new Uint8Array(await crypto.subtle.sign("HMAC", parent, encoder.encode(CAPABILITY_KEY_LABEL)));
  return hmacKey(raw, ["sign", "verify"]);
}

export async function signCapability(key: CryptoKey, claims: SignedCapabilityClaims): Promise<string> {
  const signed = `${SIGNED_CAPABILITY_PREFIX}${encodeCapabilityPayload(claims)}`;
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(signed)));
  return `${signed}.${base64urlEncode(mac)}`;
}

export async function verifyCapability(key: CryptoKey, token: string, expect: CapabilityExpectation): Promise<CapabilityCheck> {
  const parts = capabilityParts(token);
  if (!parts) return { ok: false, reason: "malformed" };
  if (!(await crypto.subtle.verify("HMAC", key, parts.mac, encoder.encode(parts.signed)))) return { ok: false, reason: "forged" };
  return admitCapability(parts.claims, expect);
}
