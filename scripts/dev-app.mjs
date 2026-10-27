import { execFile, spawn } from "node:child_process";
import { accessSync, appendFileSync, closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

export const APP_NAME = "later.dog Dev";
export const BUNDLE_ID = "dog.later.app.dev.source";
export const ICON_FILE = "later-dog-dev.icns";
export const RESTART_CODE = 75;
export const EARLIER_CODE = 76;
export const SNAPSHOT_REFS = "refs/laterdog-dev/opened";
export const SNAPSHOTS_KEPT = 12;
export const EARLIER_BUTTON = "Open an Earlier Version…";
export const SHARED_APPS = "/Applications";
const READY = /^later\.dog Dev: http/;
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const OPEN_WAIT_MS = 120_000;
const TAIL_LINES = 60;
const SESSION_POLL_MS = 250;
const NOISE = /^\s*(?:at\s|\^+\s*$|[{}]\s*$|Node\.js v\d|node:internal\/|triggerUncaughtException\(|code: ')/;
const TELLING = /error|refus|cannot|can't|could not|couldn't|in use|timed out|not found|failed|exception/i;
const PLACE = /^file:\/\/(\S+?):(\d+)$/;
const DAY_MS = 86_400_000;

export function command(file, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: env ? { ...process.env, ...env } : process.env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr ?? "") }));
      else resolve(String(stdout));
    });
  });
}

function writable(dir) {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function defaultSettings({ repo, home = homedir(), env = process.env, canWrite = writable }) {
  const tools = env.LATERDOG_DEV_DIR?.trim() || join(home, ".laterdog-dev-tools");
  return { repo, apps: canWrite(SHARED_APPS) ? SHARED_APPS : join(home, "Applications"), state: join(tools, "app"), logs: join(home, "Library", "Logs", APP_NAME), dataHome: null };
}

export function plistChanges() {
  return [["CFBundleName", APP_NAME], ["CFBundleDisplayName", APP_NAME], ["CFBundleIdentifier", BUNDLE_ID], ["CFBundleExecutable", APP_NAME], ["CFBundleIconFile", ICON_FILE]];
}

export function launcherScript() {
  return [
    "#!/bin/bash",
    'contents="$(cd "$(dirname "$0")/.." && pwd -P)"',
    'node=""',
    "best=0",
    'for candidate in "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do',
    '  [ -x "$candidate" ] || continue',
    `  score="$("$candidate" -e 'const [a, b, c] = process.versions.node.split(".").map(Number); process.stdout.write(String(a * 1000000 + b * 1000 + c))' 2>/dev/null)"`,
    '  if [ "${score:-0}" -ge 24000000 ] && [ "$score" -gt "$best" ]; then best="$score"; node="$candidate"; fi',
    "done",
    'if [ -z "$node" ]; then',
    `  /usr/bin/osascript -e 'display alert "${APP_NAME} needs Node 24 or newer" message "Install it with nvm install 24, then open ${APP_NAME} again."'`,
    "  exit 1",
    "fi",
    'exec "$node" "$contents/Resources/laterdog-dev/dev-app.mjs" open',
    "",
  ].join("\n");
}

export function electronVersion(checkout) {
  try {
    return JSON.parse(readFileSync(join(checkout, "node_modules", "electron", "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

export async function installApp({ repo, apps, state, logs, dataHome = null, others = [], source = fileURLToPath(import.meta.url), run = command }) {
  const stock = join(repo, "node_modules", "electron", "dist", "Electron.app");
  if (!existsSync(stock)) throw new Error(`Electron isn't installed in ${repo} yet. Run pnpm install there first.`);
  const electronApp = realpathSync(stock);
  const target = join(apps, `${APP_NAME}.app`);
  const staging = join(state, "staging");
  const fresh = join(staging, `${APP_NAME}.app`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  mkdirSync(apps, { recursive: true });
  await run("cp", ["-c", "-R", electronApp, fresh]).catch(async () => {
    rmSync(fresh, { recursive: true, force: true });
    await run("cp", ["-R", electronApp, fresh]);
  });
  const contents = join(fresh, "Contents");
  for (const [key, value] of plistChanges()) await run("plutil", ["-replace", key, "-string", value, join(contents, "Info.plist")]);
  copyFileSync(join(repo, "build", "dev", "icon.icns"), join(contents, "Resources", ICON_FILE));
  writeFileSync(join(contents, "MacOS", APP_NAME), launcherScript(), { mode: 0o755 });
  const own = join(contents, "Resources", "laterdog-dev");
  mkdirSync(own, { recursive: true });
  copyFileSync(source, join(own, "dev-app.mjs"));
  writeFileSync(join(own, "install.json"), `${JSON.stringify({ repo, apps, state, logs, dataHome, electron: electronVersion(repo) }, null, 2)}\n`);
  await run("xattr", ["-dr", "com.apple.quarantine", fresh]).catch(() => {});
  const previous = join(staging, "previous.app");
  if (existsSync(target)) renameSync(target, previous);
  renameSync(fresh, target);
  rmSync(staging, { recursive: true, force: true });
  await run(LSREGISTER, ["-f", target]).catch(() => {});
  for (const folder of others) {
    const other = join(folder, `${APP_NAME}.app`);
    if (other === target || !existsSync(join(other, "Contents", "Resources", "laterdog-dev", "install.json"))) continue;
    rmSync(other, { recursive: true, force: true });
    await run(LSREGISTER, ["-u", other]).catch(() => {});
  }
  return target;
}

export function refreshLauncher(target, source = fileURLToPath(import.meta.url)) {
  const own = join(target, "Contents", "Resources", "laterdog-dev");
  const next = join(own, `dev-app.mjs.${process.pid}`);
  copyFileSync(source, next);
  renameSync(next, join(own, "dev-app.mjs"));
}

export function installedSettings(file = fileURLToPath(import.meta.url)) {
  const saved = JSON.parse(readFileSync(join(dirname(file), "install.json"), "utf8"));
  return { ...saved, bundle: dirname(dirname(dirname(dirname(file)))) };
}

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const stateFile = (state) => join(state, "state.json");
const lockFile = (state) => join(state, "keeper.pid");

export function readState(state) {
  try {
    return JSON.parse(readFileSync(stateFile(state), "utf8"));
  } catch {
    return null;
  }
}

function writeState(state, value) {
  try {
    mkdirSync(state, { recursive: true });
    writeFileSync(stateFile(state), JSON.stringify({ ...value, at: Date.now() }));
  } catch {}
}

export function keeperPid(state) {
  try {
    const pid = Number(readFileSync(lockFile(state), "utf8").trim());
    return alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function takeLock(state) {
  mkdirSync(state, { recursive: true });
  const file = lockFile(state);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = openSync(file, "wx");
      writeFileSync(handle, String(process.pid));
      closeSync(handle);
      return () => {
        try {
          if (readFileSync(file, "utf8").trim() === String(process.pid)) unlinkSync(file);
        } catch {}
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (keeperPid(state)) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}

export async function openApp(settings, { startKeeper = () => startDetached(["keep"]), pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const begun = now();
  const running = keeperPid(settings.state);
  if (running && readState(settings.state)?.phase === "ready") return "ready";
  if (!running) startKeeper();
  while (now() - begun < OPEN_WAIT_MS) {
    await pause(250);
    const current = readState(settings.state);
    if (current && current.at >= begun && ["ready", "failed", "stopped"].includes(current.phase)) return current.phase;
    if (now() - begun > 5_000 && !keeperPid(settings.state)) return "stopped";
  }
  return "waiting";
}

function startDetached(args) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
}

function quoteLine(text) {
  return `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function quote(text) {
  return String(text).split("\n").map(quoteLine).join(" & linefeed & ");
}

export function dialogScript({ message, buttons, defaultButton, cancelButton }) {
  return `display dialog ${quote(message)} with title ${quote(APP_NAME)} buttons {${buttons.map(quote).join(", ")}} default button ${quote(defaultButton)}${cancelButton ? ` cancel button ${quote(cancelButton)}` : ""} with icon caution`;
}

export async function askUser(question, run = command) {
  const output = await run("osascript", ["-e", dialogScript(question)]).catch(() => "");
  return /button returned:(.*)/.exec(output)?.[1]?.trim() || question.cancelButton || null;
}

export function snapshotWhen(at, now = Date.now()) {
  const time = new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const day = (ms) => new Date(ms).toDateString();
  if (day(at) === day(now)) return `today at ${time}`;
  if (day(at) === day(now - DAY_MS)) return `yesterday at ${time}`;
  return `${new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${time}`;
}

export function snapshotLabel(entry, now = Date.now()) {
  const when = snapshotWhen(entry.at, now);
  return `${when[0].toUpperCase()}${when.slice(1)} · ${entry.message}`;
}

export async function chooseEarlier(saved, { run = command, now = Date.now() } = {}) {
  const labels = saved.map((entry) => snapshotLabel(entry, now));
  const script = `choose from list {${labels.map(quote).join(", ")}} with title ${quote(APP_NAME)} with prompt ${quote(`Open ${APP_NAME} with the code it ran:`)} default items {${quote(labels[0])}} OK button name "Open" cancel button name "Cancel"`;
  const answer = (await run("osascript", ["-e", script]).catch(() => "false")).trim();
  const picked = labels.indexOf(answer);
  return picked === -1 ? null : saved[picked];
}

const gitIn = (dir, run = command) => (args, env) => run("git", ["-C", dir, ...args], { env });

export function parseSnapshots(output) {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, commit, tree, ...message] = line.split("\t");
      return { ref, at: Number(ref.slice(SNAPSHOT_REFS.length + 1)), commit, tree, message: message.join("\t") };
    })
    .filter((entry) => entry.ref.startsWith(`${SNAPSHOT_REFS}/`) && Number.isFinite(entry.at) && entry.at > 0)
    .sort((a, b) => b.at - a.at);
}

export async function listSnapshots(repo, run = command) {
  return parseSnapshots(await gitIn(repo, run)(["for-each-ref", "--format=%(refname)%09%(objectname)%09%(tree)%09%(contents:subject)", SNAPSHOT_REFS]));
}

export async function recordSnapshot(repo, { now = Date.now(), run = command, kept = SNAPSHOTS_KEPT } = {}) {
  const git = gitIn(repo, run);
  const index = (await git(["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
  const scratch = join(tmpdir(), `laterdog-dev-snapshot-${process.pid}-${now}.index`);
  try {
    if (existsSync(index)) copyFileSync(index, scratch);
    await git(["add", "-A"], { GIT_INDEX_FILE: scratch });
    const tree = (await git(["write-tree"], { GIT_INDEX_FILE: scratch })).trim();
    const saved = await listSnapshots(repo, run);
    if (saved[0]?.tree === tree) return saved[0];
    const head = (await git(["rev-parse", "HEAD"])).trim();
    const headTree = (await git(["rev-parse", "HEAD^{tree}"])).trim();
    const subject = (await git(["log", "-1", "--format=%s", head])).trim();
    const message = tree === headTree ? subject : `${subject}, plus changes not yet committed`;
    const commit = (await git(["commit-tree", "--no-gpg-sign", tree, "-p", head, "-m", message])).trim();
    const ref = `${SNAPSHOT_REFS}/${now}`;
    await git(["update-ref", ref, commit]);
    for (const old of saved.slice(Math.max(0, kept - 1))) await git(["update-ref", "-d", old.ref]);
    return { ref, at: now, commit, tree, message };
  } finally {
    rmSync(scratch, { force: true });
  }
}

export async function prepareEarlier(settings, snapshot, run = command) {
  const dir = join(settings.state, "earlier");
  if (existsSync(join(dir, ".git"))) {
    await gitIn(dir, run)(["checkout", "--detach", "--force", snapshot.commit]);
    await gitIn(dir, run)(["clean", "-fd"]);
  } else {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    await gitIn(settings.repo, run)(["worktree", "add", "--detach", "--force", dir, snapshot.commit]);
  }
  const modules = join(dir, "node_modules");
  if (!existsSync(modules)) symlinkSync(join(settings.repo, "node_modules"), modules);
  return dir;
}

export async function refreshElectron(settings, checkout, install = installApp) {
  if (!settings.bundle) return null;
  const wanted = electronVersion(checkout);
  if (!wanted) return null;
  if (wanted !== settings.electron) {
    await install({ ...settings, source: join(settings.bundle, "Contents", "Resources", "laterdog-dev", "dev-app.mjs") });
    settings.electron = wanted;
  }
  return join(settings.bundle, "Contents", "MacOS", "Electron");
}

export function sessionEnv(settings, version, electron, base = process.env, now = Date.now()) {
  const env = { ...base, LATERDOG_DEV_SESSION: "1" };
  delete env.LATERDOG_DEV_SESSION_VERSION;
  delete env.LATERDOG_DEV_ELECTRON;
  if (version) env.LATERDOG_DEV_SESSION_VERSION = snapshotWhen(version.at, now);
  if (electron) env.LATERDOG_DEV_ELECTRON = electron;
  if (settings.dataHome) env.LATERDOG_HOME = settings.dataHome;
  return env;
}

export function openSessionLog(logs) {
  for (const folder of [logs, tmpdir()]) {
    const file = join(folder, folder === logs ? "session.log" : "laterdog-dev-session.log");
    try {
      mkdirSync(folder, { recursive: true });
      if (existsSync(file)) renameSync(file, join(folder, folder === logs ? "session.previous.log" : "laterdog-dev-session.previous.log"));
      const output = openSync(file, "a");
      return { file, output, reader: openSync(file, "r") };
    } catch {}
  }
  throw new Error(`${APP_NAME} could not open a session log`);
}

export function runSession({ checkout, env, logs, onReady = () => {}, spawnProcess = spawn, node = process.execPath, signals = process, pollMs = SESSION_POLL_MS }) {
  const { output, reader } = openSessionLog(logs);
  return new Promise((resolve) => {
    const tail = [];
    const decoder = new StringDecoder("utf8");
    const chunk = Buffer.alloc(64 * 1024);
    let ready = false;
    let interrupted = false;
    let pending = "";
    let offset = 0;
    const take = (text) => {
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.replace(COLOUR, "");
        if (!line.trim()) continue;
        tail.push(line.length > 200 ? `${line.slice(0, 199)}…` : line);
        if (tail.length > TAIL_LINES) tail.shift();
        if (!ready && READY.test(line)) {
          ready = true;
          Promise.resolve().then(onReady).catch(() => {});
        }
      }
    };
    const drain = () => {
      for (;;) {
        let read = 0;
        try {
          read = readSync(reader, chunk, 0, chunk.length, offset);
        } catch {
          return;
        }
        if (read <= 0) return;
        offset += read;
        take(decoder.write(chunk.subarray(0, read)));
      }
    };
    let child;
    try {
      child = spawnProcess(node, [join(checkout, "scripts", "dev-desktop.mjs")], { cwd: checkout, env, stdio: ["ignore", output, output] });
    } catch (error) {
      closeSync(reader);
      resolve({ code: 1, ready: false, interrupted: false, tail: [error.message], checkout });
      return;
    } finally {
      closeSync(output);
    }
    const poll = setInterval(drain, pollMs);
    const stop = () => {
      interrupted = true;
      child.kill("SIGTERM");
    };
    signals.on("SIGTERM", stop);
    signals.on("SIGINT", stop);
    child.on("error", (error) => tail.push(error.message));
    child.on("close", (code, signal) => {
      clearInterval(poll);
      drain();
      try {
        closeSync(reader);
      } catch {}
      signals.off("SIGTERM", stop);
      signals.off("SIGINT", stop);
      resolve({ code: code ?? (signal ? 1 : 0), ready, interrupted, tail, checkout });
    });
  });
}

export function failureDetail(tail, checkout = "") {
  const kept = tail.filter((line) => !NOISE.test(line));
  const telling = kept.filter((line) => TELLING.test(line) || PLACE.test(line));
  const place = (line) => line.replace(PLACE, (_, file, row) => `${checkout && file.startsWith(`${checkout}/`) ? file.slice(checkout.length + 1) : file} line ${row}`);
  return [...new Set((telling.length ? telling : kept).map(place))].slice(-4);
}

export function failureMessage({ ready, code, tail, checkout }, logs, home = homedir()) {
  const head = ready ? `${APP_NAME} stopped unexpectedly (exit code ${code}).` : `${APP_NAME} didn't start.`;
  const detail = failureDetail(tail, checkout).join("\n");
  const log = join(logs, "session.log");
  return `${head}${detail ? `\n\n${detail}` : ""}\n\nFull log: ${log.startsWith(`${home}/`) ? `~${log.slice(home.length)}` : log}`;
}

async function pickEarlier({ list, choose, ask, fallback }) {
  const saved = await list().catch(() => []);
  if (!saved.length) {
    await ask({ message: `There are no earlier versions yet. ${APP_NAME} keeps one each time it opens.`, buttons: ["OK"], defaultButton: "OK" });
    return { kind: "start", version: fallback };
  }
  return { kind: "start", version: (await choose(saved)) ?? fallback };
}

export async function nextStep(result, { version, logs, list, ask, choose }) {
  if (result.interrupted || result.code === 0) return { kind: "quit" };
  if (result.code === RESTART_CODE) return { kind: "start", version: null };
  if (result.code === EARLIER_CODE) return pickEarlier({ list, choose, ask, fallback: version });
  const saved = await list().catch(() => []);
  const again = result.ready ? "Restart" : "Try Again";
  const buttons = ["Quit", again, ...(saved.length ? [EARLIER_BUTTON] : [])];
  const answer = await ask({ message: failureMessage(result, logs), buttons, defaultButton: buttons.at(-1), cancelButton: "Quit" });
  if (answer === EARLIER_BUTTON) return pickEarlier({ list: async () => saved, choose, ask, fallback: version });
  if (answer === again) return { kind: "start", version };
  return { kind: "quit" };
}

function keeperLog(logs) {
  return (line) => {
    try {
      mkdirSync(logs, { recursive: true });
      appendFileSync(join(logs, "keeper.log"), `${new Date().toISOString()} ${line}\n`);
    } catch {}
  };
}

export async function keep(settings, deps = {}) {
  const {
    session = runSession,
    ask = (question) => askUser(question),
    choose = (saved) => chooseEarlier(saved),
    list = () => listSnapshots(settings.repo),
    snapshot = () => recordSnapshot(settings.repo),
    earlier = (picked) => prepareEarlier(settings, picked),
    electron = (checkout) => refreshElectron(settings, checkout),
    log = keeperLog(settings.logs),
  } = deps;
  const release = takeLock(settings.state);
  if (!release) return "already running";
  let version = null;
  try {
    for (;;) {
      writeState(settings.state, { phase: "starting", version: version?.ref ?? null });
      let checkout = settings.repo;
      if (version) {
        try {
          checkout = await earlier(version);
        } catch (error) {
          log(`could not open ${version.ref}: ${error.message}`);
          await ask({ message: `${APP_NAME} could not open that earlier version.\n\n${error.message}`, buttons: ["OK"], defaultButton: "OK" });
          version = null;
          continue;
        }
      }
      const executable = await Promise.resolve(electron(checkout)).catch((error) => {
        log(`keeping the stock Electron for this session: ${error.message}`);
        return null;
      });
      log(`starting ${version ? version.ref : "the latest code"} from ${checkout}`);
      const result = await session({
        checkout,
        env: sessionEnv(settings, version, executable),
        logs: settings.logs,
        onReady: async () => {
          writeState(settings.state, { phase: "ready", version: version?.ref ?? null });
          if (version) return;
          try {
            const saved = await snapshot();
            log(`saved ${saved.ref}`);
          } catch (error) {
            log(`could not save this version: ${error.message}`);
          }
        },
      });
      log(`session ended with code ${result.code}${result.ready ? "" : " before it was ready"}`);
      if (!result.ready) writeState(settings.state, { phase: "failed", version: version?.ref ?? null });
      const step = await nextStep(result, { version, logs: settings.logs, list, ask, choose });
      if (step.kind === "quit") break;
      version = step.version;
    }
  } finally {
    writeState(settings.state, { phase: "stopped", version: null });
    release();
  }
  return "stopped";
}

function readFlags(argv) {
  const flags = {};
  for (let at = 0; at < argv.length; at++) {
    const name = argv[at];
    if (name === "--open") flags.open = true;
    else if (["--apps", "--home", "--state", "--logs"].includes(name) && argv[at + 1]) flags[name.slice(2)] = argv[++at];
    else throw new Error(`unknown option ${name}`);
  }
  return flags;
}

async function install(argv) {
  const flags = readFlags(argv);
  const self = fileURLToPath(import.meta.url);
  const settings = defaultSettings({ repo: dirname(dirname(self)) });
  const chosen = {
    ...settings,
    ...(flags.apps ? { apps: flags.apps } : {}),
    ...(flags.state ? { state: flags.state } : {}),
    ...(flags.logs ? { logs: flags.logs } : {}),
    ...(flags.home ? { dataHome: flags.home } : {}),
  };
  if (keeperPid(chosen.state)) {
    const installed = join(chosen.apps, `${APP_NAME}.app`);
    if (!existsSync(join(installed, "Contents", "Resources", "laterdog-dev", "dev-app.mjs"))) throw new Error(`${APP_NAME} is open. Quit it, then run pnpm dev:app again.`);
    refreshLauncher(installed, self);
    process.stdout.write(`${APP_NAME} is open, so only its launcher was updated. The change takes effect the next time it opens.\n`);
    return;
  }
  const others = flags.apps ? [] : [SHARED_APPS, join(homedir(), "Applications")];
  const target = await installApp({ ...chosen, others });
  process.stdout.write(`Installed ${target}\nIt runs ${chosen.repo} with hot reload${chosen.dataHome ? ` on ${chosen.dataHome}` : ""}. Open it from Applications, Spotlight or the Dock.\n`);
  if (flags.open) await command("open", [target]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [action = "install", ...rest] = process.argv.slice(2);
  const work = action === "install" ? install(rest) : action === "open" ? openApp(installedSettings()) : action === "keep" ? keep(installedSettings()) : Promise.reject(new Error(`unknown command ${action}`));
  work.catch((error) => {
    process.stderr.write(`${APP_NAME}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
