import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createComputerSharing } from "../electron/computer-sharing.mjs";

const run = promisify(execFile);
export const APP_SHARING_FILE = join(homedir(), "Library", "Application Support", "later.dog", "computer-sharing.json");
export const APP_EXECUTABLE = "/Applications/later.dog.app/Contents/MacOS/later.dog";
export const DEV_SHARING_NAME = "dev-mac-sharing.json";
export const DEV_ENV_ID = "dev-cloud";
const CHECK_MS = 5_000;
const DISCONNECT_GRACE_MS = 800;

function say(line) {
  process.stdout.write(`dev mac: ${line}\n`);
}

export function readHomeSession(file) {
  const saved = JSON.parse(readFileSync(file, "utf8"));
  if (typeof saved?.url !== "string" || typeof saved?.token !== "string") throw new Error(`${file} is not a later.dog home session`);
  return { origin: new URL(saved.url).origin, token: saved.token };
}

export function appLending(sharing, origin) {
  if (!sharing || sharing.version !== 1 || sharing.homeOff === true || !sharing.records || typeof sharing.records !== "object") return null;
  for (const [envId, record] of Object.entries(sharing.records)) {
    if (record?.enabled === true && record.home === true && record.cloud?.origin === origin && typeof record.cloud.accountId === "string") return { envId, record };
  }
  return null;
}

export function devRecord(record) {
  return { ...record, sessionId: null, environmentId: null };
}

export function shouldLend({ appRunning, appLends }) {
  return !(appRunning && appLends);
}

export function devProtectedPaths(home = homedir()) {
  return [".laterdog-dev", ".laterdog-dev-tools", ".laterdog-test-home"].map((name) => join(home, name));
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

async function appIsRunning() {
  try {
    await run("pgrep", ["-f", APP_EXECUTABLE]);
    return true;
  } catch {
    return false;
  }
}

export function startDevMac({
  sessionFile, dataDir, appFile = APP_SHARING_FILE, appRunning = appIsRunning, checkMs = CHECK_MS,
  create = createComputerSharing, fetchImpl = globalThis.fetch, log = say, home = homedir(),
}) {
  const session = readHomeSession(sessionFile);
  const file = join(dataDir, DEV_SHARING_NAME);
  const authorized = (url, init = {}) => fetchImpl(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${session.token}` } });
  let sharing = null;
  let env = null;
  let timer = null;
  let stopped = false;
  let checking = Promise.resolve();

  const lend = (lent) => {
    const accountId = lent?.record.cloud.accountId ?? `dev-session-${session.origin}`;
    env = { id: lent?.envId ?? DEV_ENV_ID, name: "My Cloud", origin: session.origin };
    const saved = readJson(file);
    if (lent && saved?.records?.[env.id]?.id !== lent.record.id) {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(file, JSON.stringify({ version: 1, records: { [env.id]: devRecord(lent.record) } }), { mode: 0o600 });
    }
    const current = { status: "connected", accountId, origin: session.origin };
    const host = new URL(session.origin).hostname;
    let connected = false;
    const created = create({
      file, fetch: authorized, environments: () => [env], cloud: () => current,
      enabled: async () => false, cuaConnection: async () => null,
      hostControl: async () => ({ renew: async () => {}, release: async () => {} }),
      protectedPaths: devProtectedPaths(home), home,
      onChange: () => {
        const now = created?.state?.(env.id)?.connected === true;
        if (now === connected || sharing !== created) return;
        connected = now;
        log(now ? `this Mac is connected to ${host}` : `this Mac lost its connection to ${host}; trying again`);
      },
    });
    sharing = created;
    log(`connecting this Mac to ${host} from later.dog Dev`);
    sharing.start({ maintainer: false });
  };

  const standBy = () => {
    if (!sharing) return;
    sharing.forget(env);
    sharing.close();
    sharing = null;
    log("later.dog is open and connects this Mac, so later.dog Dev stands by");
  };

  const check = async () => {
    const lent = appLending(readJson(appFile), session.origin);
    const lendNow = shouldLend({ appRunning: await appRunning(), appLends: lent !== null });
    if (stopped) return;
    if (lendNow && !sharing) lend(lent);
    else if (!lendNow && sharing) standBy();
  };

  const tick = () => {
    checking = checking.then(check).catch((error) => log(`could not check who connects this Mac: ${error.message}`));
    return checking;
  };

  void tick().then(() => { if (!stopped) timer = setInterval(tick, checkMs); });

  return {
    lending: () => sharing !== null,
    check: tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await checking;
      if (!sharing) return;
      sharing.forget(env);
      sharing.close();
      sharing = null;
      await new Promise((resolve) => setTimeout(resolve, DISCONNECT_GRACE_MS));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [sessionFile, dataDir] = process.argv.slice(2);
  if (!sessionFile || !dataDir) {
    process.stderr.write("usage: node scripts/dev-mac.mjs <home session file> <data folder>\n");
    process.exitCode = 2;
  } else {
    const mac = startDevMac({ sessionFile, dataDir });
    const quit = () => { void mac.stop().finally(() => process.exit(0)); };
    process.once("SIGTERM", quit);
    process.once("SIGINT", quit);
  }
}
