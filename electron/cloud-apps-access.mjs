import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const CLOUD_ACCESS_FILE = "cloud-access.json";
export const APPS_SESSION_LABEL = "Apps on this Mac";
export const MINT_RETRY_DELAYS_MS = Object.freeze([20_000, 5 * 60_000, 60 * 60_000]);
const REVOKE_TIMEOUT_MS = 5_000;
const SESSION = /^laterdog_sess_[A-Za-z0-9_-]+$/;

export function cloudAccessPath(userData) {
  return path.join(userData, CLOUD_ACCESS_FILE);
}

export function parseCloudAccess(value) {
  if (!value || typeof value !== "object" || typeof value.url !== "string" || typeof value.token !== "string" || !SESSION.test(value.token)) return null;
  let origin;
  try { origin = new URL(value.url); } catch { return null; }
  if (origin.protocol !== "https:" || origin.origin !== value.url) return null;
  return { url: value.url, token: value.token };
}

export function createCloudAppsAccess({ file, fetchImpl = fetch, log = () => {}, now = Date.now }) {
  let working = null, readyFor = null, generation = 0, queue = Promise.resolve();
  let failedFor = null, failures = 0, retryAt = 0;

  function serially(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  }
  async function saved() {
    try { return parseCloudAccess(JSON.parse(await readFile(file, "utf8"))); } catch { return null; }
  }
  async function stillAccepted(access) {
    try {
      const response = await fetchImpl(`${access.url}/api/auth/session`, { headers: { accept: "application/json", authorization: `Bearer ${access.token}` }, redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (response.status === 401 || response.status === 403) { await response.body?.cancel().catch(() => {}); return false; }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return true; }
      const body = await response.json().catch(() => null);
      return body?.localTools === true;
    } catch {
      return true;
    }
  }
  async function revoke(access) {
    if (!access) return;
    try {
      const response = await fetchImpl(`${access.url}/api/auth/logout`, {
        method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
        headers: { accept: "application/json", authorization: `Bearer ${access.token}` }, signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {});
    } catch {}
  }
  async function mint(destination, startedAt) {
    const grant = await destination.grant();
    if (startedAt !== generation) return null;
    const response = await fetchImpl(`${destination.origin}/api/auth/pair`, {
      method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ code: grant.code, label: APPS_SESSION_LABEL, localTools: true }), signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || typeof body?.token !== "string" || !SESSION.test(body.token)) throw new Error(`My Cloud did not give apps a session (${response.status})`);
    return body.token;
  }
  async function save(access) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(access)}\n`, { mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
  function noteFailure(origin) {
    failures = failedFor === origin ? failures + 1 : 1;
    failedFor = origin;
    retryAt = now() + MINT_RETRY_DELAYS_MS[Math.min(failures, MINT_RETRY_DELAYS_MS.length) - 1];
  }
  function clearFailures() {
    failedFor = null; failures = 0; retryAt = 0;
  }
  async function settle(destination, startedAt) {
    const current = await saved();
    if (current?.url === destination.origin && await stillAccepted(current)) {
      if (startedAt !== generation) return null;
      readyFor = destination.origin;
      clearFailures();
      return current;
    }
    if (current) {
      await revoke(current);
      await rm(file, { force: true }).catch(() => {});
    }
    if (startedAt !== generation) return null;
    const token = await mint(destination, startedAt);
    if (!token) return null;
    const access = { url: destination.origin, token };
    if (startedAt !== generation) { await revoke(access); return null; }
    try { await save(access); } catch (error) { await revoke(access); throw error; }
    if (startedAt !== generation) return null;
    readyFor = destination.origin;
    clearFailures();
    log("cloud apps: apps on this Mac can now use My Cloud");
    return access;
  }

  return {
    ensure(destination) {
      if (!destination?.origin || typeof destination.grant !== "function" || readyFor === destination.origin) return Promise.resolve(null);
      if (working?.generation === generation) return working.run;
      if (failedFor === destination.origin && now() < retryAt) return Promise.resolve(null);
      const startedAt = generation;
      const run = serially(() => settle(destination, startedAt))
        .catch((error) => { if (startedAt === generation) noteFailure(destination.origin); log(`cloud apps: ${error?.message ?? error}`); return null; });
      working = { generation: startedAt, run };
      void run.finally(() => { if (working?.run === run) working = null; });
      return run;
    },
    forget() {
      generation += 1;
      readyFor = null;
      clearFailures();
      return serially(async () => {
        await revoke(await saved());
        await rm(file, { force: true }).catch(() => {});
      });
    },
  };
}
