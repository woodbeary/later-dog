const utf8 = new TextEncoder();
const hex = (bytes) => Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, "0")).join("");
const hash = /^[a-f0-9]{64}$/;
const chunk = 8 * 1024 * 1024;

const hmac = { name: "HMAC", hash: "SHA-256" };

export async function derivePreviousBackupKey(bootstrap) {
  if (!bootstrap) throw new Error("Missing home backup signing authority.");
  const root = await crypto.subtle.importKey("raw", utf8.encode(bootstrap), hmac, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", root, utf8.encode("laterdog.previous-cloud-signing-key.v1"));
  return new Uint8Array(derived);
}

function payload(ref) {
  if (
    !ref ||
    ref.v !== 1 ||
    ref.source !== "archive" ||
    !Number.isSafeInteger(ref.size) ||
    ref.size <= 0 ||
    ref.size > 10 * 1024 ** 3 + 256 * 1024 ** 2 ||
    !hash.test(ref.sha256) ||
    !Array.isArray(ref.chunks) ||
    ref.chunks.length !== Math.ceil(ref.size / chunk) ||
    !ref.chunks.every((h) => typeof h === "string" && hash.test(h))
  )
    return null;
  return utf8.encode(JSON.stringify(["laterdog.previous-cloud-archive.v1", ref.size, ref.sha256, ref.chunks]));
}
export async function signPreviousBackup(bootstrap, ref) {
  const bytes = payload(ref);
  if (!bytes) throw new Error("Invalid previous cloud backup reference.");
  const key = await crypto.subtle.importKey("raw", await derivePreviousBackupKey(bootstrap), hmac, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, bytes));
}
export async function verifyPreviousBackupSignatureWithKey(derived, ref) {
  const data = payload(ref);
  if (!data || !(derived instanceof Uint8Array) || derived.byteLength !== 32 || !hash.test(ref.signature)) return false;
  const signature = Uint8Array.from(ref.signature.match(/../g), (n) => parseInt(n, 16));
  const key = await crypto.subtle.importKey("raw", derived, hmac, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signature, data);
}

export async function verifyPreviousBackupSignature(bootstrap, ref) {
  return verifyPreviousBackupSignatureWithKey(await derivePreviousBackupKey(bootstrap), ref);
}
