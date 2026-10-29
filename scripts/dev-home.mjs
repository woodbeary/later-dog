import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, watch, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const homeWorker = join(root, "deploy", "laterdog", "home");
export const DEV_BUCKET = "laterdog-homes-test";
export const HOME_BUCKET = "laterdog-homes";
export const POINTER_KEY = "dev-code/current.json";
const SESSION_DIR = process.env.LATERDOG_TEST_HOME_DIR ?? join(homedir(), ".laterdog-test-home");
const WATCHED = ["server", "shared"];
const SETTLE_MS = 800;
const READY_TIMEOUT_MS = 90_000;
const IDLE_CHECK_MS = 5_000;

export function bundleKey(hash) {
  return `dev-code/${hash}.tgz`;
}

export function pointerFor(hash, label, at = new Date()) {
  return { hash, label, at: at.toISOString() };
}

export function bucketFor(url) {
  return new URL(url).hostname.endsWith("-hometest.later.dog") ? DEV_BUCKET : HOME_BUCKET;
}

export function busyDogs(bots) {
  return (Array.isArray(bots) ? bots : []).filter((bot) => bot?.busy === true).map((bot) => String(bot.name ?? "a dog"));
}

export function watchedChange(file) {
  return Boolean(file) && /\.(?:ts|mjs|json|ya?ml)$/.test(file) && !file.endsWith(".test.ts") && !file.includes("node_modules");
}

function say(line) {
  process.stdout.write(`dev home: ${line}\n`);
}

function readSessionFile(file) {
  const saved = JSON.parse(readFileSync(file, "utf8"));
  if (typeof saved?.url !== "string" || typeof saved?.token !== "string") throw new Error(`${file} is not a later.dog home session`);
  return { url: saved.url.replace(/\/+$/, ""), token: saved.token };
}

async function busyNow(home) {
  const response = await fetch(`${home.url}/api/bots?messages=0`, { headers: { authorization: `Bearer ${home.token}` }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`the home answered ${response.status}`);
  return busyDogs((await response.json())?.bots);
}

export async function waitUntilIdle(home, { check = busyNow, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = say, everyMs = IDLE_CHECK_MS } = {}) {
  let told = "";
  for (;;) {
    const busy = await check(home).catch(() => null);
    if (busy && busy.length === 0) return;
    const line = busy ? `waiting for ${busy.join(", ")} to finish before switching` : "waiting for the home to answer before switching";
    if (line !== told) log(line);
    told = line;
    await wait(everyMs);
  }
}

async function wrangler(args) {
  await run(process.execPath, [join(homeWorker, "node_modules", "wrangler", "bin", "wrangler.js"), ...args], { cwd: homeWorker, maxBuffer: 16 * 1024 * 1024 });
}

async function label() {
  const { stdout } = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: root });
  const { stdout: dirty } = await run("git", ["status", "--porcelain", "--", ...WATCHED], { cwd: root });
  return `${stdout.trim()}${dirty.trim() ? "+local" : ""}`;
}

function session(account) {
  try {
    return JSON.parse(readFileSync(join(SESSION_DIR, `${account}.session.json`), "utf8"));
  } catch {
    return null;
  }
}

async function serverPid(home) {
  try {
    const response = await fetch(`${home.url}/api/health`, { headers: { authorization: `Bearer ${home.token}` }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body?.pid === "number" ? body.pid : null;
  } catch {
    return null;
  }
}

async function waitForNewServer(home, before, started) {
  while (Date.now() - started < READY_TIMEOUT_MS) {
    const pid = await serverPid(home);
    if (pid !== null && pid !== before) return pid;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return null;
}

export async function push({ account, note, sessionFile } = {}) {
  const started = Date.now();
  const home = sessionFile ? readSessionFile(sessionFile) : account ? session(account) : null;
  const bucket = sessionFile ? bucketFor(home.url) : DEV_BUCKET;
  const before = home ? await serverPid(home) : null;
  await run(process.execPath, [join(root, "scripts", "bundle-server.mjs")], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const archive = join(await mkdtemp(join(tmpdir(), "laterdog-dev-code-")), "server.tgz");
  await run("tar", ["-czf", archive, "-C", join(root, "dist-server"), "."]);
  const bytes = await readFile(archive);
  const hash = createHash("sha256").update(bytes).digest("hex");
  await wrangler(["r2", "object", "put", `${bucket}/${bundleKey(hash)}`, "--file", archive, "--remote"]);
  const pointerFile = join(tmpdir(), `laterdog-dev-pointer-${hash.slice(0, 12)}.json`);
  const name = note ?? (await label());
  writeFileSync(pointerFile, JSON.stringify(pointerFor(hash, name)));
  if (sessionFile) await waitUntilIdle(home);
  await wrangler(["r2", "object", "put", `${bucket}/${POINTER_KEY}`, "--file", pointerFile, "--content-type", "application/json", "--remote"]);
  say(`pushed ${hash.slice(0, 12)} (${name}, ${Math.round(bytes.length / 1024)} KB) in ${Math.round((Date.now() - started) / 1000)} s`);
  if (!home) return { hash };
  const pid = await waitForNewServer(home, before, started);
  const who = account ?? new URL(home.url).hostname;
  say(pid === null ? `${who} did not come back within ${READY_TIMEOUT_MS / 1000} s; is its home awake?` : `${who} is running it (server pid ${pid}) after ${Math.round((Date.now() - started) / 1000)} s`);
  return { hash, pid };
}

export async function off({ sessionFile } = {}) {
  const bucket = sessionFile ? bucketFor(readSessionFile(sessionFile).url) : DEV_BUCKET;
  await wrangler(["r2", "object", "delete", `${bucket}/${POINTER_KEY}`, "--remote"]);
  say(`${bucket === DEV_BUCKET ? "test homes stop" : "the home stops"} picking up pushed code; one already running it keeps it until it restarts`);
}

export function pushOnSave(pushNow, { settleMs = SETTLE_MS, log = say } = {}) {
  let timer = null;
  let running = null;
  let again = false;
  const run = () => {
    if (running) { again = true; return; }
    running = Promise.resolve().then(pushNow).catch((error) => log(`push failed: ${error.message}`)).finally(() => {
      running = null;
      if (again) { again = false; run(); }
    });
  };
  return () => {
    clearTimeout(timer);
    timer = setTimeout(run, settleMs);
  };
}

function watchAndPush({ account, sessionFile }) {
  const schedule = pushOnSave(() => push({ account, sessionFile }));
  for (const dir of WATCHED) {
    watch(join(root, dir), { recursive: true }, (_event, file) => {
      if (watchedChange(file)) schedule();
    });
  }
  say(sessionFile
    ? `watching ${WATCHED.join(", ")}; every save goes to ${new URL(readSessionFile(sessionFile).url).hostname} once no dog is working`
    : `watching ${WATCHED.join(", ")}; every save is pushed to the test homes${account ? ` and checked on ${account}` : ""}`);
  if (!sessionFile) schedule();
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const accountAt = rest.indexOf("--account");
  const account = accountAt === -1 ? process.env.LATERDOG_DEV_ACCOUNT : rest[accountAt + 1];
  const sessionAt = rest.indexOf("--session");
  const sessionFile = sessionAt === -1 ? undefined : rest[sessionAt + 1];
  if (command === "push") return push({ account, sessionFile });
  if (command === "watch") return watchAndPush({ account, sessionFile });
  if (command === "off") return off({ sessionFile });
  process.stderr.write("usage: pnpm dev:home <push|watch|off> [--account test-<name> | --session <home session file>]\n");
  process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`dev home: ${error.message}\n`);
    process.exitCode = 1;
  });
}

