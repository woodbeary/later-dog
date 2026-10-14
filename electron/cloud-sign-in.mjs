export const CLOUD_CODE_LENGTH = 8;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE = /^\d{6,8}$/;
const USER_CODE = /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/;
const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_MS = 20_000;

export class CloudSignInError extends Error {
  constructor(code) {
    super(code);
    this.name = "CloudSignInError";
    this.code = code;
  }
}

const KNOWN_REFUSALS = new Map([
  ["invalid_otp", "wrong_code"],
  ["otp_expired", "expired_code"],
  ["too_many_attempts", "rate_limited"],
  ["rate_limited", "rate_limited"],
  ["invalid_email", "invalid_email"],
  ["email_unavailable", "email_unavailable"],
]);

export function normalizeEmail(value) {
  if (typeof value !== "string" || value.length > 254) return null;
  const email = value.trim().toLowerCase();
  return EMAIL.test(email) ? email : null;
}

export function normalizeCode(value) {
  if (typeof value !== "string") return null;
  const digits = value.replace(/[\s-]/g, "");
  return CODE.test(digits) ? digits : null;
}

function refusalCode(status, body) {
  const named = typeof body?.code === "string" ? body.code : typeof body?.error === "string" ? body.error : "";
  const known = KNOWN_REFUSALS.get(named.toLowerCase());
  if (known) return known;
  if (status === 429) return "rate_limited";
  if (status === 503) return "email_unavailable";
  return "unavailable";
}

async function readBody(response) {
  const reader = response.body?.getReader();
  const chunks = [];
  let size = 0;
  try {
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) throw new CloudSignInError("unavailable");
        chunks.push(value);
      }
    }
  } catch (error) {
    await reader?.cancel().catch(() => {});
    throw error;
  } finally {
    reader?.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export function createCloudSignIn({ origin, fetch: fetcher = globalThis.fetch, deviceName, platform, appVersion }) {
  async function call(method, path, { body, token } = {}) {
    let response;
    let parsed;
    try {
      response = await fetcher(`${origin}${path}`, {
        method,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_MS),
      });
      parsed = await readBody(response);
    } catch (error) {
      if (error instanceof CloudSignInError) throw error;
      throw new CloudSignInError("network");
    }
    if (!response.ok) throw new CloudSignInError(refusalCode(response.status, parsed));
    return { body: parsed, response };
  }

  async function sendCode(email) {
    const address = normalizeEmail(email);
    if (!address) throw new CloudSignInError("invalid_email");
    await call("POST", "/api/auth/email-otp/send-verification-otp", { body: { email: address, type: "sign-in" } });
    return address;
  }

  async function accountSession(address, digits) {
    const { response } = await call("POST", "/api/auth/sign-in/email-otp", {
      body: { email: address, otp: digits, name: address.split("@", 1)[0] },
    });
    const token = response.headers.get("set-auth-token");
    if (!token) throw new CloudSignInError("unavailable");
    return token;
  }

  async function approveThisComputer(accountToken) {
    const { body: started } = await call("POST", "/api/cloud/desktop/authorize", {
      body: { deviceName, platform, ...(appVersion ? { appVersion } : {}) },
    });
    if (typeof started?.userCode !== "string" || !USER_CODE.test(started.userCode) || typeof started.deviceCode !== "string") {
      throw new CloudSignInError("unavailable");
    }
    await call("POST", "/api/cloud/desktop/approve", { token: accountToken, body: { userCode: started.userCode, decision: "allow" } });
    const { body: granted } = await call("POST", "/api/cloud/desktop/token", { body: { deviceCode: started.deviceCode } });
    return granted;
  }

  async function leaveAccountSession(accountToken) {
    try {
      await call("POST", "/api/auth/sign-out", { token: accountToken, body: {} });
    } catch {}
  }

  async function verifyCode(email, code) {
    const address = normalizeEmail(email);
    const digits = normalizeCode(code);
    if (!address) throw new CloudSignInError("invalid_email");
    if (!digits) throw new CloudSignInError("wrong_code");
    const accountToken = await accountSession(address, digits);
    try {
      return await approveThisComputer(accountToken);
    } finally {
      await leaveAccountSession(accountToken);
    }
  }

  return { sendCode, verifyCode };
}
