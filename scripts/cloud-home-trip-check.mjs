import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, statfs } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { createCloudAutoMove } from "../electron/cloud-auto-move.mjs";
import { createCloudMove } from "../electron/cloud-move.mjs";
import { FIXTURE_STARTER_BOT_NAME } from "./control-laterdog.ts";
import { launchBackupFixture } from "./verify-workspace-backup.ts";

export const TRIP_SECONDS = 180;
export const TRIP_DOGS = [FIXTURE_STARTER_BOT_NAME, "Trip Planner", "Trip Writer"];
export const CADDY_CLIENT_HEADERS = Object.freeze({ "x-laterdog-client-ip": "203.0.113.5" });
const PAIRING_PATH = "/api/cloud/pairing";
const NULL_BODY = new Set([204, 205, 304]);

export function pairingSignature(secret, timestamp, nonce, body) {
  const bodyHash = createHash("sha256").update(body).digest("base64url");
  return createHmac("sha256", secret).update(`v1\n${timestamp}\n${nonce}\nPOST\n${PAIRING_PATH}\n${bodyHash}`).digest("base64url");
}

function requestBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new TypeError("the home client sends strings and bytes only");
}

export function edgeFetch({ base, origin, headers = {} }) {
  const target = new URL(base);
  const send = target.protocol === "https:" ? httpsRequest : target.protocol === "http:" ? httpRequest : null;
  if (!send) throw new Error("HOME_URL must use HTTP or HTTPS");
  const home = new URL(origin);
  return (input, init = {}) => new Promise((done, reject) => {
    const url = new URL(String(input));
    if (url.origin !== home.origin) { reject(new TypeError(`${url.origin} is not the home this check talks to`)); return; }
    const signal = init.signal ?? null;
    if (signal?.aborted) { reject(signal.reason); return; }
    const method = (init.method ?? "GET").toUpperCase();
    const body = requestBody(init.body);
    const length = body ? body.length : method === "GET" || method === "HEAD" ? null : 0;
    const sent = { ...Object.fromEntries(new Headers(init.headers)), ...headers, host: home.host, ...(length === null ? {} : { "content-length": String(length) }) };
    const pending = send({ hostname: target.hostname, port: target.port, path: `${url.pathname}${url.search}`, method, headers: sent }, (incoming) => {
      const status = incoming.statusCode ?? 0;
      if (status < 200 || (init.redirect === "error" && status >= 300 && status < 400)) {
        incoming.resume();
        reject(new TypeError(`the home answered ${status} where a response was expected`));
        return;
      }
      const received = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) received.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
      const empty = NULL_BODY.has(status) || method === "HEAD";
      if (empty) incoming.resume();
      done(new Response(empty ? null : Readable.toWeb(incoming), { status, headers: received }));
    });
    signal?.addEventListener("abort", () => pending.destroy(signal.reason), { once: true });
    pending.on("error", (error) => reject(signal?.aborted ? signal.reason : error));
    pending.end(body);
  });
}

export async function mintHomeCode(fetchHome, origin, secret, label) {
  const body = JSON.stringify({ label, ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString("base64url");
  const response = await fetchHome(`${origin}${PAIRING_PATH}`, {
    method: "POST", body, signal: AbortSignal.timeout(15_000),
    headers: {
      "content-type": "application/json", "x-laterdog-cloud-timestamp": timestamp, "x-laterdog-cloud-nonce": nonce,
      "x-laterdog-cloud-signature": `v1=${pairingSignature(secret, timestamp, nonce, body)}`,
    },
  });
  const grant = await response.json().catch(() => null);
  if (!response.ok || typeof grant?.code !== "string") throw Object.assign(new Error(`the home refused a signed pairing (${response.status})`), { status: response.status });
  return { origin, code: grant.code, expiresAt: grant.expiresAt };
}

export async function pairSession(fetchHome, origin, secret, label) {
  const { code } = await mintHomeCode(fetchHome, origin, secret, label);
  const response = await fetchHome(`${origin}/api/auth/pair`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, label }), signal: AbortSignal.timeout(15_000),
  });
  const session = await response.json().catch(() => null);
  if (!response.ok || typeof session?.token !== "string") throw new Error(`the home did not redeem its pairing code (${response.status})`);
  return session.token;
}

const shortly = (text) => JSON.stringify(text)?.slice(0, 300) ?? String(text);

export function homeAsker(fetchHome, origin, token) {
  return async (method, path, body) => {
    const response = await fetchHome(`${origin}${path}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { accept: "application/json", authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(`${method} ${path} on the home answered ${response.status}: ${shortly(parsed)}`), { status: response.status });
    return { status: response.status, body: parsed };
  };
}

export function desktopAsker(base) {
  return async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { accept: "application/json", origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${method} ${path} on the desktop fixture answered ${response.status}: ${shortly(parsed)}`);
    return { status: response.status, body: parsed };
  };
}

export function textLines(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && (message.role === "user" || message.role === "bot") && message.kind === "text" && typeof message.text === "string" && message.text.trim())
    .map((message) => ({ role: message.role, text: message.text }));
}

export async function readRoster(ask) {
  const { body } = await ask("GET", "/api/bots?messages=0");
  const bots = Array.isArray(body?.bots) ? body.bots : [];
  return Promise.all(bots.map(async (bot) => ({
    id: bot.id, name: bot.name, threadId: bot.threadId, working: bot.busy === true || bot.activity === "working",
    lines: textLines((await ask("GET", `/api/threads/${bot.threadId}/messages`)).body?.messages),
  })));
}

export function arrivalProblems(desktop, home) {
  const problems = [];
  const names = (roster) => roster.map((dog) => dog.name).sort();
  if (JSON.stringify(names(desktop)) !== JSON.stringify(names(home))) {
    problems.push(`the home lists ${shortly(names(home))} where the desktop had ${shortly(names(desktop))}`);
  }
  for (const dog of desktop) {
    const there = home.find((candidate) => candidate.name === dog.name);
    if (!there) continue;
    let from = 0;
    for (const line of dog.lines) {
      const at = there.lines.findIndex((candidate, index) => index >= from && candidate.role === line.role && candidate.text === line.text);
      if (at < 0) {
        problems.push(`${dog.name}'s chat on the home is missing the ${line.role} line ${shortly(line.text.slice(0, 80))}`);
        break;
      }
      from = at + 1;
    }
  }
  return problems;
}

export const chatCount = (roster) => roster.filter((dog) => dog.lines.some((line) => line.role === "user")).length;

export async function until(what, check, ms, stepMs = 500) {
  const deadline = Date.now() + ms;
  let last = "";
  for (;;) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? ` (${last})` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

export async function seedDesktop(base, tag) {
  const ask = desktopAsker(base);
  const { body } = await ask("GET", "/api/bots?messages=0");
  const starter = body?.bots?.find((bot) => bot.name === FIXTURE_STARTER_BOT_NAME);
  if (!starter || body.bots.length !== 1) throw new Error(`the desktop fixture should start with one dog named ${FIXTURE_STARTER_BOT_NAME}`);
  const modelSelection = { instanceId: starter.modelSelection.instanceId, model: starter.modelSelection.model };
  for (const name of TRIP_DOGS.filter((name) => name !== FIXTURE_STARTER_BOT_NAME)) await ask("POST", "/api/bots", { name, modelSelection });
  const dogs = (await ask("GET", "/api/bots?messages=0")).body.bots;
  if (JSON.stringify(dogs.map((dog) => dog.name).sort()) !== JSON.stringify([...TRIP_DOGS].sort())) throw new Error(`the desktop fixture has ${shortly(dogs.map((dog) => dog.name))}`);
  for (const dog of dogs) await ask("POST", `/api/bots/${dog.id}/messages`, { text: `First trip ${tag}: say hello, ${dog.name}.` });
  return until("every desktop dog to answer", async () => {
    const roster = await readRoster(ask);
    return roster.every((dog) => !dog.working && dog.lines.some((line) => line.role === "bot")) ? roster : null;
  }, 60_000);
}

async function homeAnswers(fetchHome, origin) {
  const response = await fetchHome(`${origin}/api/health`, { signal: AbortSignal.timeout(10_000) });
  const health = await response.json().catch(() => null);
  return response.ok && health?.app === "laterdog";
}

async function serverPid(owner) {
  const pid = (await owner("GET", "/api/health")).body?.pid;
  if (!Number.isSafeInteger(pid)) throw new Error("the home's health check did not name its server process");
  return pid;
}

export async function carryToHome({ desktopUrl, fetchHome, origin, secret, tempRoot, log }) {
  const move = createCloudMove({
    localRequest: (route, init) => fetch(`${desktopUrl}${route}`, init),
    fetchImpl: fetchHome,
    tempRoot,
    availableBytes: async (directory) => { const disk = await statfs(directory); return disk.bavail * disk.bsize; },
    log,
    pollMs: 1_000,
    restartTimeoutMs: 120_000,
    jobTimeoutMs: 120_000,
  });
  let result = null;
  const auto = createCloudAutoMove({
    move, read: () => "{}", write: () => {}, log,
    onMoved: (_destination, moved) => { result = moved; },
    onFailed: (failure) => { result = { phase: "failed", error: failure }; },
  });
  const destination = { id: "cloud", name: "My Cloud", origin, kind: "cloud", grant: () => mintHomeCode(fetchHome, origin, secret, "later.dog app (Cloud)") };
  try {
    const status = await auto.ensure("trip-check", destination);
    return { status: status.status, result: result ?? move.state() };
  } finally {
    auto.close();
    await move.close();
  }
}

async function streamSays(response, wanted, ms) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let seen = "", timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`the live stream did not carry the message within ${ms / 1000} s`)), ms); });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), late]);
      if (next.done) throw new Error("the live stream ended before it carried the message");
      seen = (seen + decoder.decode(next.value, { stream: true })).slice(-200_000);
      if (seen.includes(wanted)) return;
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
}

export async function phoneRoundTrip({ fetchHome, origin, secret, dogName, tag }) {
  const token = await pairSession(fetchHome, origin, secret, "later.dog iPhone");
  const ask = homeAsker(fetchHome, origin, token);
  const dog = (await ask("GET", "/api/bots?messages=0")).body?.bots?.find((bot) => bot.name === dogName);
  if (!dog) throw new Error(`the phone does not see ${dogName}`);
  const watching = new AbortController();
  const stream = await fetchHome(`${origin}/api/events?screens=off`, {
    headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: watching.signal,
  });
  try {
    if (!stream.ok || !stream.body || !stream.headers.get("content-type")?.startsWith("text/event-stream")) throw new Error(`the phone's live updates answered ${stream.status}`);
    const text = `Sent from the phone ${tag}`;
    const sent = await ask("POST", `/api/bots/${dog.id}/messages`, { text, threadId: dog.threadId });
    if (sent.status !== 202) throw new Error(`the phone's message was answered ${sent.status}`);
    await streamSays(stream, text, 15_000);
    const lines = textLines((await ask("GET", `/api/threads/${dog.threadId}/messages`)).body?.messages);
    if (!lines.some((line) => line.role === "user" && line.text === text)) throw new Error(`${dogName}'s chat on the home does not show the phone's message`);
    return { dog: dog.name, text };
  } finally {
    watching.abort();
  }
}

export async function runTrip({ desktopUrl, homeUrl, homeOrigin, secret, edgeHeaders = CADDY_CLIENT_HEADERS, tempRoot, log = console.log }) {
  const fetchHome = edgeFetch({ base: homeUrl, origin: homeOrigin, headers: edgeHeaders });
  const tag = randomBytes(4).toString("hex");
  const desktop = await seedDesktop(desktopUrl, tag);
  log(`desktop: ${desktop.length} dogs, ${chatCount(desktop)} chats`);
  await until("the home to answer its health check", () => homeAnswers(fetchHome, homeOrigin), 60_000, 1_000);

  const started = Date.now();
  const first = await carryToHome({ desktopUrl, fetchHome, origin: homeOrigin, secret, tempRoot, log });
  if (first.status !== "moved" || first.result?.phase !== "done") throw new Error(`the first trip did not finish: ${shortly(first)}`);
  log(`first trip: copied ${shortly(first.result.moved)} in ${Math.round((Date.now() - started) / 1000)} s`);

  const owner = homeAsker(fetchHome, homeOrigin, await pairSession(fetchHome, homeOrigin, secret, "later.dog trip check"));
  const home = await readRoster(owner);
  const problems = arrivalProblems(desktop, home);
  if (problems.length) throw new Error(`the home does not match the desktop:\n${problems.join("\n")}`);
  log(`home: the same ${home.length} dogs and ${chatCount(home)} chats`);

  const pid = await serverPid(owner);
  const again = await carryToHome({ desktopUrl, fetchHome, origin: homeOrigin, secret, tempRoot, log });
  if (again.status !== "moved" || again.result?.phase !== "done") throw new Error(`signing in again did not settle: ${shortly(again)}`);
  if (await serverPid(owner) !== pid) throw new Error("signing in again replaced the home's workspace a second time");
  log("second sign-in: nothing copied again");

  const phone = await phoneRoundTrip({ fetchHome, origin: homeOrigin, secret, dogName: TRIP_DOGS[1], tag });
  log(`phone: sent to ${phone.dog}, saw it live and read it back`);
  return { dogs: home.map((dog) => dog.name).sort(), chats: chatCount(home), moved: first.result.moved, phone };
}

async function logTail(path, lines = 40) {
  try { return (await readFile(path, "utf8")).split("\n").slice(-lines).join("\n"); } catch { return ""; }
}

export async function checkTrip({ homeUrl, homeOrigin, secret, edgeHeaders = CADDY_CLIENT_HEADERS, seconds = TRIP_SECONDS, log = console.log }) {
  const tempRoot = await mkdtemp(join(tmpdir(), "laterdog-trip-"));
  const launching = launchBackupFixture();
  let timer;
  try {
    const overdue = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`the trip took longer than ${seconds} s`)), seconds * 1000); });
    const trip = launching.then((desktop) => runTrip({ desktopUrl: desktop.info.url, homeUrl, homeOrigin, secret, edgeHeaders, tempRoot, log }));
    return await Promise.race([trip, overdue]);
  } catch (error) {
    const desktop = await launching.catch(() => null);
    const tail = desktop ? await logTail(desktop.info.logPath) : "";
    if (tail) log(`desktop fixture log (last lines):\n${tail}`);
    throw error;
  } finally {
    clearTimeout(timer);
    await (await launching.catch(() => null))?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const host = process.env.HOME_HOST;
  const secret = process.env.HOME_BOOTSTRAP_SECRET;
  if (!host || !secret) throw new Error("HOME_HOST and HOME_BOOTSTRAP_SECRET are required");
  const summary = await checkTrip({ homeUrl: process.env.HOME_URL ?? "http://127.0.0.1:8080", homeOrigin: `https://${host}`, secret });
  console.log(`trip: ok (${summary.dogs.length} dogs, ${summary.chats} chats)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(() => process.exit(0), (error) => {
    console.error(`trip: failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
