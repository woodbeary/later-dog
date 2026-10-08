// API authentication. The Worker stores only the SHA-256 of the API key (secret COMPUTERS_KEY_SHA256, lowercase hex),
// hashes the presented bearer and compares the two digests in constant time. The API is server to server: a request
// that carries an Origin header came from a browser and is refused before the key is even looked at.

export type Refusal = { status: number; code: string; message: string };

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares two strings without an early exit; only their lengths (public here: both are 64-character digests) can leak. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!;
  return difference === 0;
}

export function bearerToken(header: string | null): string | null {
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? "");
  return match ? match[1]! : null;
}

const DIGEST = /^[0-9a-f]{64}$/;

/** Undefined when the request may use the API; otherwise why not. */
export async function refuseApiRequest(headers: Headers, keySha256: string | undefined): Promise<Refusal | undefined> {
  if (headers.has("origin")) {
    return { status: 403, code: "browser_origin", message: "The computers API is called from servers only; requests with an Origin header are refused." };
  }
  const expected = keySha256?.trim().toLowerCase() ?? "";
  if (!DIGEST.test(expected)) {
    return { status: 503, code: "not_configured", message: "The COMPUTERS_KEY_SHA256 secret is not set on this Worker." };
  }
  const presented = bearerToken(headers.get("authorization"));
  if (!presented) return { status: 401, code: "unauthorized", message: "Send the API key as Authorization: Bearer ldc_..." };
  if (!constantTimeEqual(await sha256Hex(presented), expected)) {
    return { status: 401, code: "unauthorized", message: "The API key is not valid." };
  }
  return undefined;
}
