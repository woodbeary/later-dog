import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_DIR, MY_HOME_SESSION } from "./dev-connect.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
export const LOG_DIR = join(DEV_DIR, "logs");
const TEST_SESSIONS = process.env.LATERDOG_TEST_HOME_DIR ?? join(homedir(), ".laterdog-test-home");
const PHONE_REPO = process.env.LATERDOG_PHONE_REPO ?? join(homedir(), "code", "later-dog-phone");
const PHONE_PROXY_PORT = 8096;
const PROBE_PORT = 8093;
const METRO_PORT = 8081;

export function chooseHome(argv, { mySession = MY_HOME_SESSION, testDir = TEST_SESSIONS, exists = existsSync } = {}) {
  const at = argv.indexOf("--home");
  const wanted = at === -1 ? null : argv[at + 1];
  if (wanted && wanted.startsWith("test-")) {
    const file = join(testDir, `${wanted}.session.json`);
    if (!exists(file)) throw new Error(`no session for ${wanted}; run node scripts/test-home.mjs sign-in ${wanted}`);
    return { kind: "test", account: wanted, session: file };
  }
  if (wanted && wanted !== "mine") throw new Error("--home takes mine or test-<name>");
  if (!exists(mySession)) throw new Error("this Mac is not paired with your home yet; run pnpm dev:connect once");
  return { kind: "mine", account: null, session: mySession };
}

export function lanAddress(interfaces = networkInterfaces()) {
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) if (entry.family === "IPv4" && !entry.internal && /^(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./.test(entry.address)) return entry.address;
  }
  return "127.0.0.1";
}

const ESCAPE = String.fromCharCode(27);
const COLOUR = new RegExp(`${ESCAPE}\\[[0-9;]*[A-Za-z]`, "g");

export function stamp(source, line, at = new Date()) {
  return `${at.toTimeString().slice(0, 8)} ${source.padEnd(8)} | ${line.replace(COLOUR, "")}`;
}

export function plan({ home, lan, node = process.execPath, phoneRepo = PHONE_REPO }) {
  const env = { ...process.env, PATH: process.env.PATH };
  const services = [
    { name: "desktop", cwd: root, file: "pnpm", args: ["dev:desktop"], env: { ...env, LATERDOG_DEV_HOME_SESSION: home.session } },
    { name: "proxy", cwd: root, file: node, args: [join(root, "scripts", "dev-home-proxy.mjs"), home.session, String(PHONE_PROXY_PORT), "0.0.0.0"], env },
  ];
  if (existsSync(join(phoneRepo, "package.json"))) {
    const shots = join(LOG_DIR, "phone-shots");
    services.push(
      { name: "probe", cwd: phoneRepo, file: node, args: ["scripts/probe-server.mjs"], env: { ...env, PORT: String(PROBE_PORT), HOST: "0.0.0.0", SHOTS_DIR: shots } },
      { name: "metro", cwd: phoneRepo, file: "pnpm", args: ["exec", "expo", "start", "--go", "--port", String(METRO_PORT)], env: { ...env, EXPO_PUBLIC_LATERDOG_PROBE: `http://${lan}:${PROBE_PORT}`, EXPO_PUBLIC_LATERDOG_TEST_SERVER: `http://${lan}:${PHONE_PROXY_PORT}`, ...(existsSync("/Volumes/laterdog-phone") ? {} : { npm_config_store_dir: join(homedir(), "Library", "pnpm", "store") }) } },
    );
  }
  if (home.kind === "test") services.push({ name: "push", cwd: root, file: node, args: [join(root, "scripts", "dev-home.mjs"), "watch", "--account", home.account], env });
  services.push({ name: "iphone", cwd: root, file: "idevicesyslog", args: ["-n", "--no-colors", "-p", "Expo Go", "-p", "later.dog", "-p", "laterdog"], env, optional: true });
  return services;
}

function run(services) {
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  const all = createWriteStream(join(LOG_DIR, "all.log"), { flags: "a" });
  const children = [];
  const write = (source, text) => {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = stamp(source, line);
      all.write(`${entry}\n`);
      if (source !== "iphone") process.stdout.write(`${entry}\n`);
    }
  };
  for (const service of services) {
    const file = createWriteStream(join(LOG_DIR, `${service.name}.log`), { flags: "a" });
    const child = spawn(service.file, service.args, { cwd: service.cwd, env: service.env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const take = (chunk) => {
      file.write(chunk);
      write(service.name, chunk.toString("utf8"));
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (error) => write(service.name, service.optional ? `not running: ${error.message}` : `could not start: ${error.message}`));
    child.on("exit", (code, signal) => write(service.name, `stopped (exit code ${code ?? "none"}, signal ${signal ?? "none"})`));
  }
  const stop = () => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const home = chooseHome(process.argv.slice(2));
    const lan = lanAddress();
    const services = plan({ home, lan });
    process.stdout.write([
      `later.dog dev loop on ${home.kind === "mine" ? "your home" : home.account}`,
      `  desktop  later.dog Dev with hot reload against that home`,
      `  phone    Expo Go: http://${lan}:${METRO_PORT}/_expo/link?choice=expo-go&platform=ios`,
      ...(home.kind === "test" ? [`  server   every save under server/ and shared/ reloads on ${home.account} (pnpm dev:home)`] : []),
      `  logs     ${join(LOG_DIR, "all.log")} (one line per event, every source)`,
      "",
    ].join("\n"));
    run(services);
  } catch (error) {
    process.stderr.write(`dev loop: ${error.message}\n`);
    process.exitCode = 1;
  }
}
