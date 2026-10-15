import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const CLOUD_ACCESS_FILE = "cloud-access.json";
export const APPS_SESSION_LABEL = "Apps on this Mac";
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

export function createCloudAppsAccess({ file, fetchImpl = fetch, log = () => {} }) {
  let working = null, readyFor = null;

  async function saved() {
    try { return parseCloudAccess(JSON.parse(await readFile(file, "utf8"))); } catch { return null; }
  }
  async function stillAccepted(access) {
    try {
      const response = await fetchImpl(`${access.url}/api/bots`, { headers: { accept: "application/json", authorization: `Bearer ${access.token}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      await response.body?.cancel().catch(() => {});
      return response.status !== 401 && response.status !== 403;
    } catch {
      return true;
    }
  }
  async function mint(destination) {
    const grant = await destination.grant();
    const response = await fetchImpl(`${destination.origin}/api/auth/pair`, {
      method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ code: grant.code, label: APPS_SESSION_LABEL }), signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || typeof body?.token !== "string" || !SESSION.test(body.token)) throw new Error(`My Cloud did not give apps a session (${response.status})`);
    return body.token;
  }
  async function save(access) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(access)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  }

  return {
    ensure(destination) {
      if (!destination?.origin || typeof destination.grant !== "function" || readyFor === destination.origin) return Promise.resolve(null);
      working ??= (async () => {
        const current = await saved();
        if (current?.url === destination.origin && await stillAccepted(current)) { readyFor = destination.origin; return current; }
        const access = { url: destination.origin, token: await mint(destination) };
        await save(access);
        readyFor = destination.origin;
        log("cloud apps: apps on this Mac can now use My Cloud");
        return access;
      })().catch((error) => { log(`cloud apps: ${error?.message ?? error}`); return null; }).finally(() => { working = null; });
      return working;
    },
    async forget() {
      readyFor = null;
      await rm(file, { force: true }).catch(() => {});
    },
  };
}
