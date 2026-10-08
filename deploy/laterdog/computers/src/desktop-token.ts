// Signed desktop viewer links: /desktop/<id>/<expiresAt>.<mac>/ where
//   mac = base64url(HMAC-SHA256(DESKTOP_SIGNING_KEY, "laterdog-desktop\n<id>\n<generation>\n<expiresAt>"))
// The generation is the computer's boot count, kept by its Durable Object and never put in the URL: every wake starts a
// new generation, so a link dies when its computer sleeps even if the link has not expired yet.

export const DESKTOP_LINK_TTL_SECONDS = 2 * 60 * 60;
/** How far into the future an expiry may lie and still be one this Worker could have issued (clock skew allowance). */
const ISSUE_SLACK_SECONDS = 60;
const TOKEN = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

export type TokenVerdict = "valid" | "expired" | "invalid";

function signedText(id: string, generation: number, expiresAt: number): Uint8Array {
  return new TextEncoder().encode(`laterdog-desktop\n${id}\n${generation}\n${expiresAt}`);
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  if (!secret) throw new Error("DESKTOP_SIGNING_KEY is not set");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function signDesktopToken(secret: string, id: string, generation: number, expiresAt: number): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), signedText(id, generation, expiresAt));
  return `${expiresAt}.${base64url(mac)}`;
}

/** "expired" is only reported for a link this Worker really issued; anything forged, altered or stale is "invalid". */
export async function verifyDesktopToken(secret: string, id: string, generation: number, token: string, nowSeconds: number): Promise<TokenVerdict> {
  const match = TOKEN.exec(token);
  if (!match) return "invalid";
  const expiresAt = Number(match[1]);
  if (expiresAt > nowSeconds + DESKTOP_LINK_TTL_SECONDS + ISSUE_SLACK_SECONDS) return "invalid";
  const mac = fromBase64url(match[2]!);
  if (!mac || mac.length !== 32) return "invalid";
  // crypto.subtle.verify compares the MAC in constant time.
  const authentic = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), mac, signedText(id, generation, expiresAt));
  if (!authentic) return "invalid";
  return nowSeconds < expiresAt ? "valid" : "expired";
}
