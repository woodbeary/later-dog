import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEV_DIR = process.env.LATERDOG_DEV_DIR ?? join(homedir(), ".laterdog-dev-tools");
export const MY_HOME_SESSION = join(DEV_DIR, "my-home.session.json");
const PENDING_ACCOUNT = join(DEV_DIR, "account.pending.json");
const PAIR_WAIT_MS = 180_000;
const PAIR_RETRY_MS = 5_000;
const ORIGIN = process.env.LATERDOG_CLOUD_ORIGIN?.trim() || "https://accounts.later.dog";
const DEVICE_NAME = "later.dog dev tools";
const SESSION = /^laterdog_sess_[A-Za-z0-9_-]+$/;

export class CloudRefusal extends Error {
  constructor(status, code, interval) {
    super(`later.dog Cloud answered ${status}${code ? ` (${code})` : ""}`);
    this.status = status;
    this.code = code;
    this.interval = interval;
  }
}

export function nextWait(error, wait) {
  if (!(error instanceof CloudRefusal)) return wait;
  if (error.code === "authorization_pending") return wait;
  if (error.code === "slow_down") return Math.min(60_000, wait + 5_000);
  return null;
}

async function cloud(route, { method = "GET", body, token } = {}) {
  const response = await fetch(`${ORIGIN}/api/cloud/desktop/${route}`, {
    method,
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new CloudRefusal(response.status, data?.error, data?.interval);
  return data;
}

function say(line) {
  process.stdout.write(`${line}\n`);
}

async function approvedToken(start) {
  const deadline = Date.now() + start.expiresIn * 1000;
  let wait = start.interval * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return (await cloud("token", { method: "POST", body: { deviceCode: start.deviceCode } })).accessToken;
    } catch (error) {
      const next = nextWait(error, wait);
      if (next === null) throw error;
      wait = next;
    }
  }
  throw new Error("the sign-in code expired before it was approved; run pnpm dev:connect again");
}

function keptAccount() {
  try {
    const saved = JSON.parse(readFileSync(PENDING_ACCOUNT, "utf8"));
    return typeof saved?.token === "string" && saved.expiresAt > Date.now() ? saved.token : null;
  } catch {
    return null;
  }
}

async function accountToken() {
  const kept = keptAccount();
  if (kept && (await cloud("session", { token: kept }).then(() => true, () => false))) return kept;
  const start = await cloud("authorize", { method: "POST", body: { deviceName: DEVICE_NAME, platform: process.platform } });
  say(`Approve "${DEVICE_NAME}" in the browser that just opened (code ${start.userCode}).`);
  say(start.verificationUriComplete);
  execFile("open", [start.verificationUriComplete], () => {});
  const token = await approvedToken(start);
  mkdirSync(DEV_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(PENDING_ACCOUNT, JSON.stringify({ token, expiresAt: Date.now() + 24 * 3_600_000 }), { mode: 0o600 });
  return token;
}

export async function pairingGrant(ask, { waitMs = PAIR_WAIT_MS, retryMs = PAIR_RETRY_MS, onWait = () => {} } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await ask();
    } catch (error) {
      if (!(error instanceof CloudRefusal) || error.code !== "not_ready" || Date.now() + retryMs > deadline) throw error;
      onWait();
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

export async function connect() {
  const account = await accountToken();
  const session = await cloud("session", { token: account });
  const origin = session?.cloud?.origin;
  if (!["ready", "stopped"].includes(session?.cloud?.state) || typeof origin !== "string") throw new Error("your Cloud home is not ready yet; open later.dog once and try again");
  let told = false;
  const grant = await pairingGrant(() => cloud("pairing", { method: "POST", body: {}, token: account }), {
    onWait: () => { if (!told) say("Waking your home…"); told = true; },
  });
  const paired = await fetch(`${origin}/api/auth/pair`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ code: grant.code, label: DEVICE_NAME }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await paired.json().catch(() => null);
  if (!paired.ok || typeof body?.token !== "string" || !SESSION.test(body.token)) throw new Error(`your home did not pair (${paired.status})`);
  mkdirSync(DEV_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(MY_HOME_SESSION, `${JSON.stringify({ url: origin, token: body.token, account: session.account?.email ?? null })}\n`, { mode: 0o600 });
  say(`Paired with ${origin} as "${DEVICE_NAME}". Saved to ${MY_HOME_SESSION} (only you can read it).`);
  say("Sign it out any time from Settings, Account, signed-in devices.");
  await cloud("session", { method: "DELETE", body: {}, token: account }).catch(() => {});
  rmSync(PENDING_ACCOUNT, { force: true });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  connect().catch((error) => {
    process.stderr.write(`dev connect: ${error.message}\n`);
    process.exitCode = 1;
  });
}
