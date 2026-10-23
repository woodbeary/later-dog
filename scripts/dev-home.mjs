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
export const POINTER_KEY = "dev-code/current.json";
const SESSION_DIR = process.env.LATERDOG_TEST_HOME_DIR ?? join(homedir(), ".laterdog-test-home");
const WATCHED = ["server", "shared"];
const SETTLE_MS = 800;
const READY_TIMEOUT_MS = 90_000;

export function bundleKey(hash) {
  return `dev-code/${hash}.tgz`;
}

export function pointerFor(hash, label, at = new Date()) {
  return { hash, label, at: at.toISOString() };
}

export function watchedChange(file) {
  return Boolean(file) && /\.(?:ts|mjs|json|ya?ml)$/.test(file) && !file.endsWith(".test.ts") && !file.includes("node_modules");
}

function say(line) {
  process.stdout.write(`dev home: ${line}\n`);
}

async function wrangler(args) {
  await run("pnpm", ["exec", "wrangler", ...args], { cwd: homeWorker, maxBuffer: 16 * 1024 * 1024 });
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

export async function push({ account, note } = {}) {
  const started = Date.now();
  const home = account ? session(account) : null;
  const before = home ? await serverPid(home) : null;
  await run(process.execPath, [join(root, "scripts", "bundle-server.mjs")], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const archive = join(await mkdtemp(join(tmpdir(), "laterdog-dev-code-")), "server.tgz");
  await run("tar", ["-czf", archive, "-C", join(root, "dist-server"), "."]);
  const bytes = await readFile(archive);
  const hash = createHash("sha256").update(bytes).digest("hex");
  await wrangler(["r2", "object", "put", `${DEV_BUCKET}/${bundleKey(hash)}`, "--file", archive, "--remote"]);
  const pointerFile = join(tmpdir(), `laterdog-dev-pointer-${hash.slice(0, 12)}.json`);
  const name = note ?? (await label());
  writeFileSync(pointerFile, JSON.stringify(pointerFor(hash, name)));
  await wrangler(["r2", "object", "put", `${DEV_BUCKET}/${POINTER_KEY}`, "--file", pointerFile, "--content-type", "application/json", "--remote"]);
  say(`pushed ${hash.slice(0, 12)} (${name}, ${Math.round(bytes.length / 1024)} KB) in ${Math.round((Date.now() - started) / 1000)} s`);
  if (!home) return { hash };
  const pid = await waitForNewServer(home, before, started);
  say(pid === null ? `${account} did not come back within ${READY_TIMEOUT_MS / 1000} s; is its home awake?` : `${account} is running it (server pid ${pid}) after ${Math.round((Date.now() - started) / 1000)} s`);
  return { hash, pid };
}

export async function off() {
  await wrangler(["r2", "object", "delete", `${DEV_BUCKET}/${POINTER_KEY}`, "--remote"]);
  say("test homes stop picking up pushed code; one already running it keeps it until it restarts");
}

function watchAndPush(account) {
  let timer = null;
  let pushing = Promise.resolve();
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      pushing = pushing.then(() => push({ account })).catch((error) => say(`push failed: ${error.message}`));
    }, SETTLE_MS);
  };
  for (const dir of WATCHED) {
    watch(join(root, dir), { recursive: true }, (_event, file) => {
      if (watchedChange(file)) schedule();
    });
  }
  say(`watching ${WATCHED.join(", ")}; every save is pushed to the test homes${account ? ` and checked on ${account}` : ""}`);
  schedule();
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const accountAt = rest.indexOf("--account");
  const account = accountAt === -1 ? process.env.LATERDOG_DEV_ACCOUNT : rest[accountAt + 1];
  if (command === "push") return push({ account });
  if (command === "watch") return watchAndPush(account);
  if (command === "off") return off();
  process.stderr.write("usage: pnpm dev:home <push|watch|off> [--account test-<name>]\n");
  process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`dev home: ${error.message}\n`);
    process.exitCode = 1;
  });
}

