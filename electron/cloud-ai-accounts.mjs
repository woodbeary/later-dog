import { execFile as nodeExecFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { Readable } from "node:stream";

const ACCOUNT_HANDOVER_RETRY_MS = Object.freeze([20_000, 60_000, 5 * 60_000, 15 * 60_000]);

export const MAC_ACCOUNT_ROUTES = /^\/api\/laterdog\/mac-accounts(?:\/(?:claude|codex|claude-\d{1,4}|claude-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/hold)?$/;
const ACCOUNT_ID = /^(?:claude|codex|claude-\d{1,4}|claude-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const KEYCHAIN_SERVICE = /^Claude Code-credentials(?:-[0-9a-f]{8})?$/;
const KEYCHAIN_ACCOUNT = /^[a-zA-Z0-9._-]+$/;
const SECRET_FILES = new Set([".credentials.json", "auth.json"]);
const MAX_SECRET_BYTES = 256 * 1024;
const SECURITY = "/usr/bin/security";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const FINAL_REFUSALS = Object.freeze(["home_signed_in", "different_account"]);
export const REFUSALS_KEPT = Object.freeze([...FINAL_REFUSALS, "other_device", "not_signed_in"]);

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const filled = value => typeof value === "string" && value.length > 0;
const plainName = value => typeof value === "string" && value.trim() ? value.replace(/\p{Cc}+/gu, " ").trim().slice(0, 80) : null;
const plainEmail = value => typeof value === "string" && value.length <= 254 && EMAIL.test(value) && !/[\p{Cc}\p{Cf}]/u.test(value) ? value : null;

export function decodeKeychainText(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed.startsWith("{") && trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed)) return Buffer.from(trimmed, "hex").toString("utf8");
  return trimmed;
}

export function claudeStoreFrom(text) {
  let root;
  try { root = JSON.parse(decodeKeychainText(text)); } catch { return null; }
  if (!record(root)) return null;
  const login = root.claudeAiOauth;
  const usable = record(login) && filled(login.accessToken) && filled(login.refreshToken) && Number.isFinite(login.expiresAt) && Array.isArray(login.scopes);
  return { root, login: usable ? login : null };
}

export function codexStoreFrom(text) {
  let root;
  try { root = JSON.parse(text); } catch { return null; }
  if (!record(root)) return null;
  const tokens = root.tokens;
  const usable = record(tokens) && filled(tokens.id_token) && filled(tokens.access_token) && filled(tokens.refresh_token);
  return { root, login: usable ? root : null };
}

export const refreshTokenOf = (kind, login) => (kind === "claude" ? login.refreshToken : login.tokens.refresh_token);
export const loginFingerprint = refreshToken => createHash("sha256").update(refreshToken).digest("hex").slice(0, 16);

export function parseMacAccountSource(value) {
  if (!record(value) || typeof value.instanceId !== "string") return null;
  const displayName = plainName(value.displayName);
  if (!displayName) return null;
  if (value.kind === "chatgpt-plan") return { instanceId: value.instanceId, kind: "chatgpt-plan", displayName };
  if ((value.kind !== "claude" && value.kind !== "codex") || !ACCOUNT_ID.test(value.instanceId) || (value.instanceId === "codex") !== (value.kind === "codex")) return null;
  if (typeof value.file !== "string" || !isAbsolute(value.file) || !SECRET_FILES.has(basename(value.file))) return null;
  const keychain = record(value.keychain) && KEYCHAIN_SERVICE.test(value.keychain.service) && KEYCHAIN_ACCOUNT.test(value.keychain.account)
    ? { service: value.keychain.service, account: value.keychain.account } : null;
  const email = plainEmail(value.email);
  return { instanceId: value.instanceId, kind: value.kind, displayName, held: value.held === true, file: value.file, ...(keychain ? { keychain } : {}), ...(email ? { email } : {}) };
}

const DEVICE_ID = /^[0-9a-f]{32}$/;

const FINGERPRINT = /^[0-9a-f]{16}$/;

function parseRefusals(saved) {
  const refused = {};
  for (const [id, entry] of Object.entries(record(saved) ? saved : {})) {
    if (!ACCOUNT_ID.test(id) || !record(entry) || !REFUSALS_KEPT.includes(entry.code) || typeof entry.origin !== "string") continue;
    refused[id] = { code: entry.code, origin: entry.origin, fingerprint: FINGERPRINT.test(entry.fingerprint) ? entry.fingerprint : null, at: Number.isSafeInteger(entry.at) ? entry.at : 0 };
  }
  return refused;
}

export function parseAccountRecords(raw) {
  let value;
  try { value = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return { origin: null, deviceId: null, accounts: {}, refused: {} }; }
  const accounts = {};
  const saved = record(value) && record(value.accounts) ? value.accounts : {};
  const fallbackOrigin = record(value) && typeof value.origin === "string" ? value.origin : null;
  for (const [id, entry] of Object.entries(saved)) {
    if (!ACCOUNT_ID.test(id) || !record(entry) || !["claude", "codex"].includes(entry.kind) || !["keychain", "file"].includes(entry.source) || !plainName(entry.name)) continue;
    accounts[id] = { kind: entry.kind, name: plainName(entry.name), source: entry.source, origin: typeof entry.origin === "string" ? entry.origin : fallbackOrigin, at: Number.isSafeInteger(entry.at) ? entry.at : 0 };
  }
  return { origin: fallbackOrigin, deviceId: record(value) && DEVICE_ID.test(value.deviceId) ? value.deviceId : null, accounts, refused: parseRefusals(record(value) ? value.refused : null) };
}

export function serializeAccountRecords(records) {
  return `${JSON.stringify({ version: 2, origin: records.origin, deviceId: records.deviceId, accounts: records.accounts, refused: records.refused ?? {} }, null, 2)}\n`;
}

export function homeOriginAllowed(origin) {
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.origin !== origin) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
}

export async function readSecretFile(path) {
  if (typeof path !== "string" || !isAbsolute(path) || !SECRET_FILES.has(basename(path))) return null;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SECRET_BYTES) return null;
    return await handle.readFile("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function createMacKeychain({ execFile = nodeExecFile, timeoutMs = 60_000 } = {}) {
  const valid = item => record(item) && KEYCHAIN_SERVICE.test(item.service) && KEYCHAIN_ACCOUNT.test(item.account);
  const run = args => new Promise(resolve => {
    try {
      execFile(SECURITY, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8", shell: false, windowsHide: true },
        (error, stdout) => resolve(error ? null : String(stdout ?? "")));
    } catch { resolve(null); }
  });
  return {
    async has(item) {
      if (!valid(item)) return false;
      return await run(["find-generic-password", "-a", item.account, "-s", item.service]) !== null;
    },
    async read(item) {
      if (!valid(item)) return null;
      const stdout = await run(["find-generic-password", "-a", item.account, "-w", "-s", item.service]);
      return stdout ? stdout : null;
    },
  };
}

async function readJson(response, limit = 512 * 1024) {
  const chunks = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of Readable.fromWeb(response.body)) {
      size += chunk.length;
      if (size > limit) return null;
      chunks.push(chunk);
    }
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"); } catch { return null; }
}

const holdRoute = instanceId => `/api/laterdog/mac-accounts/${instanceId}/hold`;
const homeRoute = instanceId => `/api/laterdog/accounts/${instanceId}`;

export function createCloudAiAccounts({ localRequest, fetchImpl = fetch, keychain = null, readFile = readSecretFile,
  read, write, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, retryDelaysMs = ACCOUNT_HANDOVER_RETRY_MS, onChange = () => {}, log = () => {} }) {
  if (typeof localRequest !== "function" || typeof read !== "function" || typeof write !== "function") throw new Error("Moving accounts needs this Mac's server and a place to remember them.");
  let running = null, timer = null, failures = 0, doneFor = null, closed = false;

  const records = () => { try { return parseAccountRecords(read()); } catch { return { origin: null, deviceId: null, accounts: {}, refused: {} }; } };
  const save = next => { try { write(serializeAccountRecords(next)); return true; } catch { log("cloud accounts: could not save which accounts are on My Cloud"); return false; } };
  const stopTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };

  async function local(method, route) {
    if (!MAC_ACCOUNT_ROUTES.test(route)) throw new Error("invalid_request");
    const response = await localRequest(route, { method, redirect: "error", signal: AbortSignal.timeout(30_000) });
    return { status: response.status, body: await readJson(response) };
  }
  async function listed() {
    const answer = await local("GET", "/api/laterdog/mac-accounts");
    if (answer.status !== 200 || !Array.isArray(answer.body?.accounts)) throw new Error("local_unavailable");
    return answer.body.accounts.map(parseMacAccountSource).filter(Boolean);
  }
  async function openHome(destination) {
    if (!homeOriginAllowed(destination?.origin) || typeof destination.grant !== "function") throw new Error("cloud_unavailable");
    const grant = await destination.grant();
    if (!record(grant) || grant.origin !== destination.origin || typeof grant.code !== "string") throw new Error("cloud_unavailable");
    const response = await fetchImpl(`${destination.origin}/api/auth/pair`, {
      method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ code: grant.code, label: "Accounts from this Mac" }), signal: AbortSignal.timeout(30_000),
    });
    const body = await readJson(response);
    if (!response.ok || typeof body?.token !== "string" || !body.token.startsWith("laterdog_sess_")) throw new Error("cloud_unavailable");
    return { origin: destination.origin, token: body.token };
  }
  async function home(session, method, route, body) {
    const response = await fetchImpl(`${session.origin}${route}`, {
      method, redirect: "error", credentials: "omit", cache: "no-store",
      headers: { accept: "application/json", authorization: `Bearer ${session.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
    });
    return { status: response.status, body: await readJson(response) };
  }
  async function closeHome(session) {
    try {
      const response = await fetchImpl(`${session.origin}/api/auth/logout`, { method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
        headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(10_000) });
      await response.body?.cancel().catch(() => {});
    } catch {}
  }

  async function storeOf(source) {
    const parse = source.kind === "claude" ? claudeStoreFrom : codexStoreFrom;
    if (source.kind === "claude" && source.keychain && keychain) {
      const text = await keychain.read(source.keychain);
      if (text !== null) {
        const store = parse(text);
        return store ? { ...store, from: "keychain" } : { unreadable: true };
      }
      if (await keychain.has(source.keychain)) return { unreadable: true };
    }
    const text = await readFile(source.file);
    const store = text === null ? null : parse(text);
    return store ? { ...store, from: "file" } : null;
  }
  async function present(source) {
    if (source.kind === "claude" && source.keychain && keychain && await keychain.has(source.keychain)) return true;
    return await readFile(source.file) !== null;
  }

  function deviceId() {
    const saved = records();
    if (saved.deviceId) return saved.deviceId;
    const fresh = randomBytes(16).toString("hex");
    if (!save({ ...saved, deviceId: fresh })) throw new Error("cannot_remember_device");
    return fresh;
  }

  const refused = (status, body) => status === 422 || status === 400 || status === 413 || status === 415 || (status === 409 && body?.code !== "busy");
  const refusalCode = (status, body) => (typeof body?.code === "string" && /^[a-z_]{1,40}$/.test(body.code) ? body.code : `http_${status}`);

  function rememberRefusal(source, destination, refusal) {
    const saved = records();
    return save({ ...saved, refused: { ...saved.refused, [source.instanceId]: { ...refusal, origin: destination.origin, at: now() } } });
  }

  async function stillRefused(source, refusal) {
    if (FINAL_REFUSALS.includes(refusal.code)) return true;
    try {
      const store = await storeOf(source);
      if (!store?.login) return true;
      return refusal.fingerprint === loginFingerprint(refreshTokenOf(source.kind, store.login));
    } catch {
      return true;
    }
  }

  async function release(source) {
    try {
      const answer = await local("DELETE", holdRoute(source.instanceId));
      return answer.status === 200;
    } catch {
      return false;
    }
  }

  async function handOver(source, session, destination, device) {
    const held = await local("PUT", holdRoute(source.instanceId));
    if (held.status !== 200) return { outcome: "waiting", session };
    let outcome = "waiting";
    let free = false;
    try {
      const store = await storeOf(source);
      if (store?.unreadable) { outcome = "unreadable"; free = true; }
      else if (!store?.login) { outcome = "absent"; free = true; }
      else {
        session ??= await openHome(destination);
        const handoff = { kind: source.kind, displayName: source.displayName, deviceId: device, login: store.login };
        let sent = await home(session, "PUT", homeRoute(source.instanceId), source.email ? { ...handoff, email: source.email } : handoff);
        if (sent.status === 400 && source.email) sent = await home(session, "PUT", homeRoute(source.instanceId), handoff);
        if (sent.status === 200 && sent.body?.signedIn === true) {
          const saved = records();
          const refusedNow = { ...saved.refused };
          delete refusedNow[source.instanceId];
          outcome = save({ ...saved, origin: destination.origin, refused: refusedNow, accounts: { ...saved.accounts, [source.instanceId]: { kind: source.kind, name: source.displayName, source: store.from, origin: destination.origin, at: now() } } }) ? "moved" : "waiting";
        } else if (refused(sent.status, sent.body)) {
          const code = refusalCode(sent.status, sent.body);
          log(`cloud accounts: My Cloud did not take ${source.displayName} (${code})`);
          if (REFUSALS_KEPT.includes(code)) rememberRefusal(source, destination, { code, fingerprint: loginFingerprint(refreshTokenOf(source.kind, store.login)) });
          outcome = code === "home_signed_in" ? "home" : "refused";
          free = true;
        }
      }
    } catch {
      outcome = "waiting";
    }
    if (free && !(await release(source))) {
      log(`cloud accounts: ${source.displayName} is still paused on this Mac`);
      outcome = "waiting";
    }
    return { outcome, session };
  }

  async function moveUp(destination) {
    const summary = { moved: { claude: 0, chatgpt: 0 }, stayed: [], waiting: [] };
    let session = null;
    try {
      const sources = await listed();
      const saved = records();
      let device = null;
      for (const source of sources) {
        if (source.kind === "chatgpt-plan") { summary.stayed.push({ name: source.displayName, why: "chatgpt-plan" }); continue; }
        try {
          const entry = saved.accounts[source.instanceId];
          if (entry) {
            if (entry.origin !== destination.origin) { summary.stayed.push({ name: source.displayName, why: "elsewhere" }); continue; }
            if (!source.held) await local("PUT", holdRoute(source.instanceId)).catch(() => {});
            continue;
          }
          const refusal = saved.refused[source.instanceId];
          if (refusal && refusal.origin === destination.origin && await stillRefused(source, refusal)) {
            if (source.held) await release(source);
            continue;
          }
          if (!(await present(source))) {
            if (source.held) await release(source);
            continue;
          }
          device ??= deviceId();
          const step = await handOver(source, session, destination, device);
          session = step.session;
          if (step.outcome === "moved") summary.moved[source.kind === "claude" ? "claude" : "chatgpt"]++;
          else if (step.outcome === "waiting") summary.waiting.push(source.displayName);
          else if (step.outcome !== "absent") summary.stayed.push({ name: source.displayName, why: step.outcome });
        } catch {
          summary.waiting.push(source.displayName);
        }
      }
    } catch (error) {
      log(`cloud accounts: could not list this Mac's sign-ins (${error?.message ?? error})`);
      summary.waiting.push("");
    } finally {
      if (session) await closeHome(session);
    }
    return summary;
  }

  function scheduleRetry(destination, handOverNow) {
    if (closed) return;
    const delay = retryDelaysMs[Math.min(failures++, retryDelaysMs.length - 1)];
    stopTimer();
    timer = setTimer(() => { timer = null; void handOverNow(destination).catch(() => {}); }, delay);
    timer?.unref?.();
  }

  function run(destination) {
    if (running) return running;
    running = (async () => {
      const summary = await moveUp(destination);
      const waiting = summary.waiting.filter(Boolean);
      if (summary.waiting.length) scheduleRetry(destination, run);
      else { failures = 0; doneFor = destination.origin; }
      const shown = { ...summary, waiting };
      try { onChange(shown); } catch {}
      return shown;
    })().finally(() => { running = null; });
    return running;
  }

  const api = {
    records: () => records(),
    handAccountsToCloud({ homeOrigin, session }) {
      if (closed || !homeOrigin) return Promise.resolve(null);
      if (running) return running;
      if (timer !== null || doneFor === homeOrigin) return Promise.resolve(null);
      const grant = typeof session === "function" ? session : null;
      return run({ origin: homeOrigin, grant });
    },
    stop() { stopTimer(); failures = 0; doneFor = null; },
    close() { closed = true; stopTimer(); },
  };
  return api;
}
