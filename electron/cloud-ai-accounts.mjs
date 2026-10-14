import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { AUTO_MOVE_RETRY_MS } from "./cloud-auto-move.mjs";

export const MAC_ACCOUNT_ROUTES = /^\/api\/laterdog\/mac-accounts(?:\/(?:claude|codex|claude-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/hold)?$/;
const ACCOUNT_ID = /^(?:claude|codex|claude-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const KEYCHAIN_SERVICE = /^Claude Code-credentials(?:-[0-9a-f]{8})?$/;
const KEYCHAIN_ACCOUNT = /^[a-zA-Z0-9._-]+$/;
const SECRET_FILES = new Set([".credentials.json", "auth.json"]);
const MAX_SECRET_BYTES = 256 * 1024;
const SECURITY = "/usr/bin/security";
const STDIN_LIMIT = 4032;

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const filled = value => typeof value === "string" && value.length > 0;
const plainName = value => typeof value === "string" && value.trim() ? value.replace(/\p{Cc}+/gu, " ").trim().slice(0, 80) : null;

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
  return { instanceId: value.instanceId, kind: value.kind, displayName, held: value.held === true, file: value.file, ...(keychain ? { keychain } : {}) };
}

export function parseAccountRecords(raw) {
  let value;
  try { value = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return { origin: null, accounts: {} }; }
  const accounts = {};
  const saved = record(value) && record(value.accounts) ? value.accounts : {};
  for (const [id, entry] of Object.entries(saved)) {
    if (!ACCOUNT_ID.test(id) || !record(entry) || !["claude", "codex"].includes(entry.kind) || !["keychain", "file"].includes(entry.source) || !plainName(entry.name)) continue;
    accounts[id] = { kind: entry.kind, name: plainName(entry.name), source: entry.source, at: Number.isSafeInteger(entry.at) ? entry.at : 0 };
  }
  return { origin: record(value) && typeof value.origin === "string" ? value.origin : null, accounts };
}

export function serializeAccountRecords(records) {
  return `${JSON.stringify({ version: 1, origin: records.origin, accounts: records.accounts }, null, 2)}\n`;
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

export async function writeSecretFile(path, text) {
  if (typeof path !== "string" || !isAbsolute(path) || !SECRET_FILES.has(basename(path))) throw new Error("invalid_path");
  const folder = dirname(path);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temporary = join(folder, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export function createMacKeychain({ execFile = nodeExecFile, spawn = nodeSpawn, timeoutMs = 60_000 } = {}) {
  const valid = item => record(item) && KEYCHAIN_SERVICE.test(item.service) && KEYCHAIN_ACCOUNT.test(item.account);
  const run = args => new Promise(resolve => {
    try {
      execFile(SECURITY, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8", shell: false, windowsHide: true },
        (error, stdout) => resolve(error ? null : String(stdout ?? "")));
    } catch { resolve(null); }
  });
  const finished = (child, input) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("keychain_timeout")); }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); reject(new Error("keychain_unavailable")); });
    child.once("exit", status => { clearTimeout(timer); if (status === 0) resolve(); else reject(new Error("keychain_refused")); });
    if (input !== undefined) child.stdin.end(input);
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
    async write(item, text) {
      if (!valid(item)) throw new Error("keychain_refused");
      const hex = Buffer.from(text, "utf8").toString("hex");
      const command = `add-generic-password -U -a "${item.account}" -s "${item.service}" -X "${hex}"\n`;
      if (command.length <= STDIN_LIMIT) {
        await finished(spawn(SECURITY, ["-i"], { stdio: ["pipe", "ignore", "ignore"], shell: false, windowsHide: true }), command);
        return;
      }
      await finished(spawn(SECURITY, ["add-generic-password", "-U", "-a", item.account, "-s", item.service, "-X", hex], { stdio: ["ignore", "ignore", "ignore"], shell: false, windowsHide: true }));
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

export function createCloudAiAccounts({ localRequest, fetchImpl = fetch, keychain = null, readFile = readSecretFile, writeFile = writeSecretFile,
  read, write, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, retryDelaysMs = AUTO_MOVE_RETRY_MS, onChange = () => {}, log = () => {} }) {
  if (typeof localRequest !== "function" || typeof read !== "function" || typeof write !== "function") throw new Error("Moving accounts needs this Mac's server and a place to remember them.");
  let running = null, timer = null, failures = 0, doneFor = null, gaveUpFor = null, closed = false;

  const records = () => { try { return parseAccountRecords(read()); } catch { return { origin: null, accounts: {} }; } };
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

  async function handOver(source, session, destination) {
    const held = await local("PUT", holdRoute(source.instanceId));
    if (held.status !== 200) return { outcome: "waiting", session };
    let outcome = "waiting";
    try {
      const store = await storeOf(source);
      if (store?.unreadable) outcome = "unreadable";
      else if (!store?.login) outcome = "absent";
      else {
        session ??= await openHome(destination);
        const sent = await home(session, "PUT", homeRoute(source.instanceId), { kind: source.kind, displayName: source.displayName, login: store.login });
        if (sent.status === 200 && sent.body?.signedIn === true) {
          const saved = records();
          outcome = save({ origin: destination.origin, accounts: { ...saved.accounts, [source.instanceId]: { kind: source.kind, name: source.displayName, source: store.from, at: now() } } }) ? "moved" : "waiting";
        } else if (sent.status === 409 && sent.body?.code === "home_signed_in") outcome = "home";
      }
    } catch {
      outcome = "waiting";
    }
    if (outcome !== "moved") {
      try { await local("DELETE", holdRoute(source.instanceId)); } catch { log(`cloud accounts: ${source.displayName} is still paused on this Mac`); }
    }
    return { outcome, session };
  }

  async function moveUp(destination) {
    const summary = { moved: { claude: 0, chatgpt: 0 }, stayed: [], waiting: [] };
    let session = null;
    try {
      const sources = await listed();
      const saved = records();
      for (const source of sources) {
        if (source.kind === "chatgpt-plan") { summary.stayed.push({ name: source.displayName, why: "chatgpt-plan" }); continue; }
        if (saved.accounts[source.instanceId]) {
          if (!source.held) await local("PUT", holdRoute(source.instanceId)).catch(() => {});
          continue;
        }
        if (!(await present(source))) {
          if (source.held) await local("DELETE", holdRoute(source.instanceId)).catch(() => {});
          continue;
        }
        const step = await handOver(source, session, destination);
        session = step.session;
        if (step.outcome === "moved") summary.moved[source.kind === "claude" ? "claude" : "chatgpt"]++;
        else if (step.outcome === "home" || step.outcome === "unreadable") summary.stayed.push({ name: source.displayName, why: step.outcome });
        else if (step.outcome === "waiting") summary.waiting.push(source.displayName);
      }
    } catch {
      summary.waiting.push("");
    } finally {
      if (session) await closeHome(session);
    }
    return summary;
  }

  async function restore(source, entry, login, received) {
    const current = await storeOf(source);
    if (current?.unreadable) throw new Error("unreadable");
    const mine = current?.login ? loginFingerprint(refreshTokenOf(source.kind, current.login)) : null;
    if (mine !== null && mine !== received) return;
    if (source.kind === "codex") { await writeFile(source.file, `${JSON.stringify(login, null, 2)}\n`); return; }
    const merged = JSON.stringify({ ...current?.root, claudeAiOauth: login });
    if (entry.source === "keychain" && source.keychain && keychain) await keychain.write(source.keychain, merged);
    else await writeFile(source.file, merged);
  }

  async function moveDown(destination) {
    const result = { returned: [], stayed: [] };
    const saved = records();
    const ids = Object.keys(saved.accounts);
    if (!ids.length) return result;
    let session = null, sources = new Map();
    try { sources = new Map((await listed()).map(source => [source.instanceId, source])); } catch {}
    const forget = id => { const now = records(); delete now.accounts[id]; save(now); };
    for (const id of ids) {
      const entry = saved.accounts[id];
      const source = sources.get(id);
      try {
        session ??= await openHome(destination);
        const back = await home(session, "POST", `${homeRoute(id)}/return`);
        if (back.status === 404 || back.status === 410) {
          await local("DELETE", holdRoute(id)).catch(() => {});
          await home(session, "DELETE", homeRoute(id)).catch(() => {});
          forget(id);
          result.returned.push(entry.name);
          continue;
        }
        const login = back.status === 200 && back.body?.kind === entry.kind
          ? (entry.kind === "claude" ? claudeStoreFrom(JSON.stringify({ claudeAiOauth: back.body.login })) : codexStoreFrom(JSON.stringify(back.body.login)))?.login : null;
        if (!login || typeof back.body.received !== "string") {
          if (back.status === 200) await home(session, "POST", `${homeRoute(id)}/keep`).catch(() => {});
          result.stayed.push(entry.name);
          continue;
        }
        try {
          if (source && source.kind !== "chatgpt-plan") await restore(source, entry, login, back.body.received);
          const released = await local("DELETE", holdRoute(id));
          if (released.status !== 200 && released.status !== 404) throw new Error("local_refused");
        } catch {
          await home(session, "POST", `${homeRoute(id)}/keep`).catch(() => {});
          result.stayed.push(entry.name);
          continue;
        }
        await home(session, "DELETE", homeRoute(id)).catch(() => {});
        forget(id);
        result.returned.push(entry.name);
      } catch {
        result.stayed.push(entry.name);
      }
    }
    if (session) await closeHome(session);
    return result;
  }

  function scheduleRetry(destination) {
    if (closed || failures >= retryDelaysMs.length) { gaveUpFor = destination.origin; return false; }
    const delay = retryDelaysMs[failures++];
    stopTimer();
    timer = setTimer(() => { timer = null; void run(destination).catch(() => {}); }, delay);
    timer?.unref?.();
    return true;
  }

  function run(destination) {
    if (running) return running;
    running = (async () => {
      const summary = await moveUp(destination);
      const waiting = summary.waiting.filter(Boolean);
      if (summary.waiting.length) {
        const retrying = scheduleRetry(destination);
        if (!retrying) log(`cloud accounts: ${waiting.length || "some"} account(s) stayed on this Mac after retries`);
      } else { failures = 0; doneFor = destination.origin; }
      const shown = { ...summary, waiting };
      try { onChange(shown); } catch {}
      return shown;
    })().finally(() => { running = null; });
    return running;
  }

  return {
    records: () => records(),
    ensure(destination) {
      if (closed || !destination?.origin) return Promise.resolve(null);
      if (running) return running;
      if (timer !== null || doneFor === destination.origin || gaveUpFor === destination.origin) return Promise.resolve(null);
      return run(destination);
    },
    async bringBack(destination) {
      stopTimer();
      if (running) await running.catch(() => {});
      doneFor = null; gaveUpFor = null; failures = 0;
      return moveDown(destination);
    },
    stop() { stopTimer(); failures = 0; doneFor = null; gaveUpFor = null; },
    close() { closed = true; stopTimer(); },
  };
}
