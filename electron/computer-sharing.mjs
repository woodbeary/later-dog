import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createSharedCua, executeSharedOperation, personalSecretPaths, sharedComputerError } from "./shared-computer-access.mjs";
import { createLendingActivity, describeSharedOperation } from "./lending-activity.mjs";

const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const DATA_VOLUME = "/System/Volumes/Data";
const identify = async candidate => { const info = await fsp.stat(candidate, { bigint: true }); return `${info.dev}:${info.ino}`; };
const RETRY_MS = 5000;
const RETRY_MAX_MS = 60_000;
const PAIR_FIRST_MS = 30_000;
const PAIR_MAX_MS = 15 * 60_000;
const HOME_WORDS = { asleep: "My Cloud is resting.", waking: "My Cloud is waking up.", busy: "later.dog is busy right now." };
const UNNAMED = "This computer";
const CUA_OFF = process.platform === "darwin"
  ? "later.dog can't use apps on this Mac yet. On the Mac, turn on later.dog in System Settings → Privacy & Security → Accessibility and Screen Recording. If it still can't, quit and reopen later.dog on the Mac."
  : "later.dog can't use apps on this computer yet. Open later.dog on it and allow computer use, then try again.";
// oxlint-disable-next-line no-control-regex
const plainName = value => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 120) : "";

export function computerName({ platform = process.platform, hostname = os.hostname } = {}) {
  const fallback = () => plainName(String(hostname()).replace(/\.local$/i, "")) || UNNAMED;
  if (platform !== "darwin") return Promise.resolve(fallback());
  return new Promise(resolve => {
    execFile("/usr/sbin/scutil", ["--get", "ComputerName"], { timeout: 2000, encoding: "utf8" }, (error, stdout) => resolve((!error && plainName(stdout)) || fallback()));
  });
}

function homeCandidates() {
  const home = path.resolve(os.homedir());
  const seeds = [home];
  if (process.platform === "darwin" && !home.startsWith(`${DATA_VOLUME}${path.sep}`)) seeds.push(path.join(DATA_VOLUME, home));
  return seeds;
}

async function enclosingHomeIdentities() {
  const identities = new Set();
  const [home, ...aliases] = homeCandidates();
  const canonicalHome = await fsp.realpath(home);
  const homeIdentity = await identify(canonicalHome);
  const roots = [canonicalHome];
  for (const alias of aliases) {
    try {
      const canonical = await fsp.realpath(alias);
      if ((await identify(canonical)) === homeIdentity) roots.push(canonical);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }
  for (let current of roots) {
    for (;;) {
      identities.add(await identify(current));
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return identities;
}

async function volumeRoot(canonical) {
  const parent = path.dirname(canonical);
  if (parent === canonical) return true;
  try { return (await fsp.stat(parent, { bigint: true })).dev !== (await fsp.stat(canonical, { bigint: true })).dev; } catch { return true; }
}

export async function validateSharedFolders(folders) {
  if (!Array.isArray(folders) || folders.length > 20) throw new Error("Choose at most 20 shared folders");
  const result = [];
  const enclosing = await enclosingHomeIdentities();
  for (const folder of folders) {
    if (!uuid(folder?.id) || typeof folder.path !== "string" || !path.isAbsolute(folder.path) || typeof folder.write !== "boolean") throw new Error("Choose folders using the desktop folder picker");
    const canonical = await fsp.realpath(folder.path);
    if (!(await fsp.stat(canonical)).isDirectory()) throw new Error("Choose a folder, not a file");
    if (enclosing.has(await identify(canonical)) || (await volumeRoot(canonical))) throw new Error("Choose specific folders, not the entire computer or home folder");
    if (result.some(entry => entry.id === folder.id || entry.path === canonical)) continue;
    result.push({ id: folder.id, path: canonical, name: path.basename(canonical).slice(0, 120), write: folder.write });
  }
  return result;
}

const JOB_KEYS = new Set(["computer_id", "action", "folder_id", "path", "content", "encoding", "expected_sha256", "offset", "length", "command", "tool_name", "arguments"]);
const wholeNumber = (value, max) => value === undefined || (Number.isSafeInteger(value) && value >= 0 && value <= max);
const JOB_ACTIONS = new Set(["list_files", "read_file", "write_file", "run_command", "computer_tools", "computer_call"]);
const optionalText = (value, max) => value === undefined || (typeof value === "string" && value.length <= max);
export function validSharedOperation(operation, computerId) {
  return Boolean(operation) && typeof operation === "object" && !Array.isArray(operation) &&
    Object.keys(operation).every(key => JOB_KEYS.has(key)) &&
    operation.computer_id === computerId && JOB_ACTIONS.has(operation.action) &&
    (operation.folder_id === undefined || uuid(operation.folder_id)) &&
    optionalText(operation.path, 2048) && optionalText(operation.content, 350_000) &&
    (operation.encoding === undefined || operation.encoding === "utf8" || operation.encoding === "base64") &&
    (operation.expected_sha256 === undefined || (typeof operation.expected_sha256 === "string" && /^[a-f0-9]{64}$/.test(operation.expected_sha256))) &&
    wholeNumber(operation.offset, 64 * 1024 * 1024) && wholeNumber(operation.length, 256 * 1024) &&
    optionalText(operation.command, 8000) && optionalText(operation.tool_name, 100) &&
    (operation.arguments === undefined || (Boolean(operation.arguments) && typeof operation.arguments === "object" && !Array.isArray(operation.arguments)));
}

export function cloudLendingVerdict(binding, current, env) {
  if (!binding || current?.status === "signed-out") return { stop: "signed-out" };
  if (current?.accountId && current.accountId !== binding.accountId) return { stop: "account-changed" };
  if (env?.origin !== binding.origin || (current?.origin && current.origin !== binding.origin)) return { stop: "machine-changed" };
  if (!current?.accountId) return { pause: "unverified" };
  if (current.status !== "connected" && current.status !== "unavailable") return { pause: current.status };
  return { allow: true };
}

class Paused extends Error {}

export function createComputerSharing({
  file, fetch: fetchImpl, environments, cuaConnection, hostControl, protectedPaths = [], enabled = async () => false, home = os.homedir(), activityFile,
  cloud = () => null, onChange = () => {}, pairCloud = null, primeAccess = async () => {}, computerName: nameComputer = computerName, retryMs = RETRY_MS,
}) {
  const protectedRoots = [path.dirname(file), ...protectedPaths.filter(entry => typeof entry === "string" && entry), ...personalSecretPaths(home)];
  const activity = createLendingActivity(activityFile ?? path.join(path.dirname(file), "lending-activity.jsonl"));
  let records = {};
  let homeOff = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.version === 1 && parsed.records && typeof parsed.records === "object") { records = parsed.records; homeOff = parsed.homeOff === true; }
  } catch {}
  const running = new Map();
  const status = new Map();
  let closed = false;
  let maintainerOff = false;
  let executing = null;
  let homing = null;
  let homeAgain = false;
  let naming = null;
  let shownName = null;
  let pairAfter = 0;
  let pairWait = PAIR_FIRST_MS;
  const macName = () => naming ??= Promise.resolve().then(() => nameComputer()).catch(() => UNNAMED)
    .then(name => (shownName = plainName(name) || UNNAMED));
  const homeFolder = async id => ({ id: uuid(id) ? id : randomUUID(), path: await fsp.realpath(home), name: "Home", write: true });
  const changed = () => { if (!closed) try { onChange(summary()); } catch {} };
  const summary = () => ({
    lending: environments().filter(env => records[env.id]?.cloud && records[env.id]?.enabled === true).map(env => env.id),
    busy: executing,
  });
  const requireEnabled = async () => {
    const allowed = !closed && !maintainerOff && await enabled().catch(() => false);
    if (allowed && !closed && !maintainerOff) return;
    maintainerOff = true;
    for (const env of environments()) {
      if (records[env.id]?.cloud || !running.has(env.id)) continue;
      if (status.get(env.id)?.connected) disconnect(env, records[env.id]); else stop(env.id);
    }
    throw new Error("Computer sharing is turned off on this computer. Restart the desktop after enabling it.");
  };
  const endCloud = (env, reason) => {
    disconnect(env, records[env.id]);
    if (records[env.id]?.enabled) store({ ...records, [env.id]: { ...records[env.id], enabled: false } });
    status.set(env.id, { connected: false, problem: reason });
    changed();
  };
  const requireGrant = async (env, grant) => {
    if (!grant.cloud) return requireEnabled();
    if (closed) throw new Paused("This app is closing.");
    const verdict = cloudLendingVerdict(grant.cloud, cloud(), env);
    if (verdict.allow) return;
    if (verdict.stop) { endCloud(env, verdict.stop); throw new Error("Lending to My Cloud stopped."); }
    throw new Paused("Waiting for your later.dog Cloud sign-in.");
  };
  const store = (next, off = homeOff) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, records: next, ...(off ? { homeOff: true } : {}) }), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file); records = next; homeOff = off;
  };
  const request = async (env, route, body, signal, secret) => {
    const origin = new URL(env.origin);
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new Error("Computer sharing requires an HTTPS server address");
    const response = await fetchImpl(`${env.origin}${route}`, {
      method: body === undefined ? "GET" : "POST", credentials: "include", redirect: "error", cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(10_000),
      headers: { origin: env.origin, "x-laterdog-lending": "1", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(secret ? { "x-laterdog-computer-secret": secret } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length; if (bytes > 4_000_000) throw new Error("Server response exceeded limit");
      chunks.push(Buffer.from(chunk));
    }
    let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
    if (!response.ok) {
      const header = name => { try { return response.headers?.get?.(name) ?? null; } catch { return null; } };
      const said = header("x-laterdog-home") ?? (response.status === 503 ? json?.error : null);
      const wake = typeof said === "string" && Object.hasOwn(HOME_WORDS, said) ? said : null;
      const retryAfter = Number(json?.retryAfter ?? header("retry-after"));
      const message = wake ? HOME_WORDS[wake] : response.status === 401 || response.status === 403
        ? "Pair this desktop again before sharing computer access." : `Server request failed (${response.status}). Update the server if needed.`;
      throw Object.assign(new Error(message), { status: response.status, ...(wake ? { home: wake } : {}), ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}) });
    }
    if (!json || typeof json !== "object") throw new Error("This server does not support computer sharing. Update its later.dog installation.");
    return json;
  };
  const describe = async env => {
    let auth, descriptor;
    try {
      auth = await request(env, "/api/auth/session");
      descriptor = await request(env, "/.well-known/laterdog/environment");
    } catch (error) { throw error.status === 401 || error.status === 403 ? Object.assign(error, { problem: "connect-first" }) : error; }
    if (auth.kind !== "session" || !uuid(auth.id) || !uuid(descriptor.environmentId)) throw Object.assign(new Error("Complete server pairing or sign-in first"), { problem: "connect-first" });
    if (descriptor.capabilities?.sharedComputers !== true) throw new Error("Update this server to enable computer sharing");
    return { auth, info: { sessionId: auth.id, environmentId: descriptor.environmentId } };
  };
  const identity = async env => {
    await requireEnabled();
    const { info } = await describe(env);
    await requireEnabled();
    return info;
  };
  const cloudIdentity = async env => {
    const { auth, info } = await describe(env);
    if (auth.cloudHome !== true || !Array.isArray(auth.scopes) || !auth.scopes.includes("admin")) throw Object.assign(new Error("This server is not My Cloud"), { problem: "not-cloud" });
    return info;
  };
  const matches = (grant, info) => grant?.sessionId === info.sessionId && grant?.environmentId === info.environmentId;
  const stop = id => {
    const live = running.get(id);
    if (live) { live.abort.abort(); live.cua?.close(); running.delete(id); }
    status.set(id, { connected: false });
  };
  const pairQuietly = async (env, signal) => {
    if (!pairCloud || closed || Date.now() < pairAfter) return false;
    pairAfter = Date.now() + pairWait;
    pairWait = Math.min(PAIR_MAX_MS, pairWait * 2);
    try {
      const pairing = await pairCloud();
      if (signal.aborted || pairing?.origin !== env.origin || typeof pairing.code !== "string") return false;
      const label = await macName();
      for (let attempt = 0; ; attempt++) {
        try {
          await request(env, "/api/auth/pair", { code: pairing.code, label, cookie: true }, signal);
          break;
        } catch (error) {
          if ((error.home !== "waking" && error.home !== "busy") || attempt >= 4) throw error;
          await delay(Math.min(10_000, (error.retryAfter ?? 2) * 1000), undefined, { signal });
        }
      }
      return !signal.aborted;
    } catch { return false; }
  };
  const run = (env, grant) => {
    stop(env.id);
    if (closed || !grant.enabled || (!grant.cloud && maintainerOff)) return;
    const live = { abort: new AbortController(), cua: null };
    running.set(env.id, live);
    const signal = live.abort.signal;
    const call = (action, body = {}) => request(env, `/api/shared-computers/${grant.id}/${action}`, body, signal, grant.secret);
    const gate = () => requireGrant(env, grant);
    void (async () => {
      let failures = 0;
      while (!signal.aborted) {
        let wait = retryMs;
        try {
          await gate();
          if (grant.cloud) {
            const info = await cloudIdentity(env);
            pairAfter = 0; pairWait = PAIR_FIRST_MS;
            if (grant.environmentId && grant.environmentId !== info.environmentId) {
              endCloud(env, "machine-changed");
              if (grant.home) void ensureHome();
              break;
            }
            if (grant.environmentId !== info.environmentId || grant.sessionId !== info.sessionId) {
              grant = { ...grant, ...info };
              if (records[env.id]?.id === grant.id) store({ ...records, [env.id]: grant });
            }
          } else if (!matches(grant, await identity(env))) throw new Error("Server sign-in changed. Review computer access again in Settings.");
          if (grant.home) {
            const folder = await homeFolder(grant.folders[0]?.id);
            if (grant.folders.length !== 1 || folder.id !== grant.folders[0].id || folder.path !== grant.folders[0].path) {
              grant = { ...grant, folders: [folder] };
              if (records[env.id]?.id === grant.id) store({ ...records, [env.id]: grant });
            }
          } else await validateSharedFolders(grant.folders);
          const effectiveGrant = { ...grant, protectedPaths: protectedRoots };
          await gate();
          await request(env, "/api/shared-computers/connect", {
            id: grant.id, name: await macName(), environmentId: grant.environmentId,
            folders: grant.folders.map(({ id, name, write }) => ({ id, name, write })), terminal: grant.terminal, computer: grant.computer,
            ...(grant.home ? { home: true } : {}),
          }, signal, grant.secret);
          if (signal.aborted) break;
          failures = 0;
          status.set(env.id, { connected: true });
          changed();
          while (!signal.aborted) {
            await gate();
            const { job } = await call("poll");
            await gate();
            if (!job) continue;
            if (!uuid(job.id)) throw new Error("Invalid computer request");
            if (!validSharedOperation(job.operation, grant.id)) {
              activity.record({ env, action: "invalid", detail: "", ok: false, error: "Refused a malformed request" });
              await call("result", { jobId: job.id, result: sharedComputerError(new Error("Invalid computer request")) });
              continue;
            }
            if (executing) { await call("result", { jobId: job.id, result: sharedComputerError(new Error("This computer is busy with another server")) }); continue; }
            executing = { env: env.id, action: job.operation.action };
            changed();
            const jobAbort = new AbortController();
            const jobSignal = AbortSignal.any([signal, jobAbort.signal]);
            let leasing = false;
            let control;
            const lease = async () => {
              if (leasing) return;
              leasing = true;
              try {
                await gate();
                if (!(await call("lease", { jobId: job.id })).active) jobAbort.abort();
                await control?.renew();
              } catch { jobAbort.abort(); }
              finally { leasing = false; }
            };
            const heartbeat = setInterval(() => void lease(), 1000);
            let result;
            try {
              await lease(); jobSignal.throwIfAborted();
              if (grant.computer && ["computer_tools", "computer_call"].includes(job.operation.action)) {
                if (!hostControl) throw new Error("The local computer control gate is unavailable");
                control = await hostControl(job.id, jobSignal);
                jobSignal.throwIfAborted();
              }
              const stopped = new Promise((_, reject) => {
                const quit = () => reject(new Error("Computer access was revoked or the requesting turn ended. Inspect the result before retrying."));
                if (jobSignal.aborted) quit(); else jobSignal.addEventListener("abort", quit, { once: true });
              });
              stopped.catch(() => {});
              result = await Promise.race([stopped, executeSharedOperation(effectiveGrant, job.operation, jobSignal, async () => {
                if (!live.cua) {
                  const connection = await cuaConnection();
                  jobSignal.throwIfAborted();
                  if (!connection?.mcpCommand || !Array.isArray(connection.mcpArgs)) throw new Error(CUA_OFF);
                  live.cua = createSharedCua(connection);
                }
                return live.cua;
              })]);
            } catch (error) { result = sharedComputerError(error); live.cua?.close(); live.cua = null; }
            finally { clearInterval(heartbeat); await control?.release().catch(() => {}); executing = null; changed(); }
            activity.record({
              env, action: job.operation.action, detail: describeSharedOperation(grant, job.operation), ok: result?.isError !== true,
              error: result?.isError === true ? result?.content?.[0]?.text : undefined,
            });
            await call("result", { jobId: job.id, result });
          }
        } catch (error) {
          if (error instanceof Paused) {
            if (running.get(env.id) === live) disconnect(env, grant);
            status.set(env.id, { connected: false, problem: "paused" });
            changed();
            break;
          }
          if (signal.aborted) break;
          const problem = error.problem ?? (error.home === "asleep" ? "asleep" : "waiting");
          if (grant.cloud && (problem === "connect-first" || (problem === "asleep" && !grant.sessionId)) && await pairQuietly(env, signal)) continue;
          if (signal.aborted) break;
          status.set(env.id, { connected: false, error: error.message, ...(grant.cloud ? { problem } : {}) });
          changed();
          wait = error.retryAfter ? Math.min(RETRY_MAX_MS, Math.max(1000, error.retryAfter * 1000)) : Math.min(RETRY_MAX_MS, retryMs * 2 ** Math.min(failures, 4));
          failures++;
        }
        try { await delay(wait, undefined, { signal }); } catch { break; }
      }
    })().catch(() => {});
  };
  const state = id => {
    const grant = records[id];
    return { enabled: grant?.enabled === true, folders: Array.isArray(grant?.folders) ? grant.folders : [], terminal: grant?.terminal === true, computer: grant?.computer === true, ...status.get(id) };
  };
  const disconnect = (env, grant) => {
    stop(env.id);
    if (grant?.secret) void request(env, `/api/shared-computers/${grant.id}/disconnect`, {}, undefined, grant.secret).catch(() => {});
  };
  const cloudState = env => {
    const grant = env ? records[env.id] : undefined;
    const lent = grant?.cloud ? grant : null;
    return {
      on: !homeOff,
      ...(shownName ? { name: shownName } : {}),
      enabled: lent?.enabled === true,
      busy: Boolean(env && executing?.env === env.id),
      ...(env ? status.get(env.id) : {}),
    };
  };
  const validRecord = grant => grant?.enabled === true && uuid(grant.id) && /^[a-f0-9]{64}$/.test(grant.secret) && Array.isArray(grant.folders) &&
    (grant.cloud
      ? typeof grant.cloud.accountId === "string" && typeof grant.cloud.origin === "string" && (grant.environmentId === null || uuid(grant.environmentId))
      : uuid(grant.sessionId) && uuid(grant.environmentId));
  const homeOnce = async () => {
    if (closed || homeOff) return;
    const current = cloud();
    if (current?.status !== "connected" || !current.accountId || !current.origin) return;
    const env = environments().find(entry => entry.origin === current.origin);
    if (!env) return;
    const old = records[env.id];
    const same = old?.home === true && old.cloud?.accountId === current.accountId && old.cloud?.origin === env.origin;
    if (same && validRecord(old)) {
      if (!running.has(env.id)) run(env, old);
      return;
    }
    const keep = same && uuid(old.id) && /^[a-f0-9]{64}$/.test(old.secret ?? "");
    const folder = await homeFolder(keep ? old.folders?.[0]?.id : undefined);
    const now = cloud();
    if (closed || homeOff || now?.status !== "connected" || now.accountId !== current.accountId || now.origin !== env.origin) return;
    if (!environments().some(entry => entry.id === env.id)) return;
    const grant = {
      sessionId: null, environmentId: null, id: keep ? old.id : randomUUID(), secret: keep ? old.secret : randomBytes(32).toString("hex"),
      enabled: true, home: true, folders: [folder], terminal: true, computer: true, cloud: { accountId: current.accountId, origin: env.origin },
    };
    const previous = records[env.id];
    if (previous && previous.id !== grant.id) disconnect(env, previous); else stop(env.id);
    store({ ...records, [env.id]: grant });
    run(env, grant);
    changed();
    if (!keep) void Promise.resolve().then(() => primeAccess()).catch(() => {});
  };
  const ensureHome = () => {
    if (homing) { homeAgain = true; return homing; }
    homing = (async () => {
      try {
        do { homeAgain = false; await homeOnce(); } while (homeAgain && !closed);
      } catch {} finally { homing = null; }
    })();
    return homing;
  };
  return {
    state, identity,
    activity(id, limit) {
      const env = id === undefined ? null : environments().find(entry => entry.id === id);
      const entries = activity.list(env ? 500 : limit);
      return (env ? entries.filter(entry => entry.origin === env.origin) : entries).slice(0, limit ?? 100);
    },
    async observe(env) {
      const info = await identity(env);
      if (matches(records[env.id], info)) return null;
      disconnect(env, records[env.id]);
      return info;
    },
    decline(env, info) { disconnect(env, records[env.id]); store({ ...records, [env.id]: { ...info, enabled: false, folders: [], terminal: false, computer: false } }); },
    async save(env, input, info) {
      const fresh = await identity(env);
      if (!matches(info, fresh)) throw new Error("Server sign-in changed. Review computer access again.");
      const folders = await validateSharedFolders(input.folders);
      await requireEnabled();
      const grant = { ...fresh, id: randomUUID(), secret: randomBytes(32).toString("hex"), enabled: true, folders, terminal: input.terminal === true, computer: input.computer === true };
      if (!folders.length && !grant.terminal && !grant.computer) throw new Error("Choose at least one folder or capability to share");
      disconnect(env, records[env.id]);
      store({ ...records, [env.id]: grant }); run(env, grant); changed(); return state(env.id);
    },
    cloudState,
    async setHome(on) {
      if (closed) return;
      if (on) {
        if (homeOff) store(records, false);
        changed();
        await ensureHome();
        return;
      }
      let next = records;
      for (const env of environments()) {
        const grant = records[env.id];
        if (!grant?.cloud) continue;
        disconnect(env, grant);
        if (grant.enabled) next = { ...next, [env.id]: { ...grant, enabled: false } };
      }
      store(next, true);
      changed();
    },
    revoke(env) {
      const grant = records[env.id];
      disconnect(env, grant);
      if (grant) store({ ...records, [env.id]: { ...grant, enabled: false } }, grant.cloud ? true : homeOff);
      changed();
      return state(env.id);
    },
    forget(env) { disconnect(env, records[env.id]); const next = { ...records }; delete next[env.id]; store(next); changed(); },
    start({ maintainer = true } = {}) {
      for (const env of environments()) {
        const grant = records[env.id];
        if (!validRecord(grant)) continue;
        if (grant.cloud) { if (cloudLendingVerdict(grant.cloud, cloud(), env).allow) run(env, grant); }
        else if (maintainer && !maintainerOff) run(env, grant);
      }
      void macName().then(() => changed());
      void ensureHome();
      changed();
    },
    cloudChanged() {
      if (closed) return;
      for (const env of environments()) {
        const grant = records[env.id];
        if (!grant?.cloud || grant.enabled !== true) continue;
        const verdict = cloudLendingVerdict(grant.cloud, cloud(), env);
        if (verdict.stop) endCloud(env, verdict.stop);
        else if (verdict.pause) { if (running.has(env.id)) { disconnect(env, grant); status.set(env.id, { connected: false, problem: "paused" }); changed(); } }
        else if (!running.has(env.id) && validRecord(grant)) run(env, grant);
      }
      void ensureHome();
    },
    close() { closed = true; for (const id of running.keys()) stop(id); },
  };
}
