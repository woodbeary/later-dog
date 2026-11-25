import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { cpus, homedir, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  DEV,
  LIVE_DATA_ENV,
  LIVE_DATA_FLAG,
  RELEASE,
  SCRIPT_DEFAULTS,
  dataDirFor,
  describeVariant,
  insidePath,
  ownedPorts,
  profilesDataDirFor,
  userDataDirFor,
} from "../electron/app-variant.mjs";
import { LAUNCH_TIMELINE_ENV } from "../electron/launch-timeline.mjs";
import { pollServerIdentity } from "../electron/server-boot-probe.mjs";
import { ISOLATED_DELETIONS } from "./dev-safe.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export const SEGMENTS = Object.freeze([
  ["electron boot", "runner-spawn", "main-process-start"],
  ["main imports", "main-process-start", "main-imports-done"],
  ["imports → app ready", "main-imports-done", "app-ready"],
  ["startup checks", "app-ready", "startup-cache-checked"],
  ["native splash wait", "native-splash-created", "native-splash-ready"],
  ["secure credentials", "credentials-loading", "credentials-loaded"],
  ["credential state", "credentials-loaded", "credential-state-ready"],
  ["server start (in app)", "server-starting", "server-started"],
  ["supervisor", "server-started", "supervisor-started"],
  ["organization restore", "organization-restoring", "organization-restored"],
  ["organization + cloud entry", "organization-restored", "cloud-entry-ready"],
  ["app ready → create window", "app-ready", "create-window"],
  ["create window → ready-to-show", "create-window", "window-ready-to-show"],
  ["create window → page loaded", "create-window", "window-did-finish-load"],
  ["create window → first paint", "create-window", "renderer-first-paint"],
  ["create window → window shown", "create-window", "window-shown"],
  ["window shown → message box on screen", "window-shown", "message-box-on-screen"],
  ["native splash on screen", "native-splash-shown", "native-splash-closed"],
  ["launch splash shown → leaving", "renderer-launch-splash-shown", "renderer-launch-splash-leaving"],
  ["launch splash leaving → gone", "renderer-launch-splash-leaving", "renderer-message-box-ready"],
  ["main start → message box on screen", "main-process-start", "message-box-on-screen"],
  ["total: spawn → message box on screen", "runner-spawn", "message-box-on-screen"],
]);

export function defaultAppData(realHome = homedir(), platform = process.platform, env = process.env) {
  if (platform === "darwin") return join(realHome, "Library", "Application Support");
  if (platform === "win32") return env.APPDATA || join(realHome, "AppData", "Roaming");
  return env.XDG_CONFIG_HOME || join(realHome, ".config");
}

export function refusal({ dataRoot, realHome = homedir(), env = process.env, argv = process.argv, appData = defaultAppData(realHome, process.platform, env) }) {
  if (argv.includes(LIVE_DATA_FLAG) || env[LIVE_DATA_ENV] === "1") return `The launch timeline never uses live data. Remove ${LIVE_DATA_FLAG} / ${LIVE_DATA_ENV}.`;
  const root = resolve(dataRoot);
  const protectedFolders = [
    realHome,
    join(realHome, ".laterdog-v0"),
    join(realHome, SCRIPT_DEFAULTS.dataDirName),
    ...[RELEASE, DEV].flatMap((id) => {
      const definition = describeVariant(id);
      const folders = [dataDirFor(definition, { env: {}, home: realHome }), profilesDataDirFor(definition, { env: {}, home: realHome })];
      return [...folders, userDataDirFor(definition, appData)];
    }),
  ];
  for (const folder of protectedFolders) {
    if (insidePath(root, folder) || (folder !== realHome && insidePath(folder, root))) return `Refusing to run in ${root}: it overlaps ${folder}, which belongs to an installed or Dev later.dog.`;
  }
  return null;
}

export function protectedPorts() {
  return [...new Set([...ownedPorts(describeVariant(RELEASE)), ...ownedPorts(describeVariant(DEV))])].sort((a, b) => a - b);
}

export function portFree(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => server.close(() => done(true)));
  });
}

export function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

export function median(sorted) {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function markTimes(run) {
  const times = new Map();
  if (typeof run.spawnedAt === "number") times.set("runner-spawn", run.spawnedAt);
  for (const entry of run.report?.marks ?? []) times.set(entry.name, entry.at);
  if (times.has("renderer-message-box-ready") && times.has("renderer-first-paint")) {
    times.set("message-box-on-screen", Math.max(times.get("renderer-message-box-ready"), times.get("renderer-first-paint")));
  }
  return times;
}

export function segmentsOf(run) {
  const times = markTimes(run);
  const durations = {};
  for (const [label, from, to] of SEGMENTS) {
    if (times.has(from) && times.has(to)) durations[label] = times.get(to) - times.get(from);
  }
  if (typeof run.serverBootMs === "number") durations["fixture server boot (outside app)"] = run.serverBootMs;
  return durations;
}

export function summarize(runs) {
  const labels = [...SEGMENTS.map(([label]) => label), "fixture server boot (outside app)"];
  const rows = [];
  for (const label of labels) {
    const values = runs.map((run) => segmentsOf(run)[label]).filter((value) => typeof value === "number").sort((a, b) => a - b);
    if (!values.length) continue;
    rows.push({ label, n: values.length, median: median(values), p95: percentile(values, 0.95), min: values[0], max: values.at(-1) });
  }
  return rows;
}

const ms = (value) => (value === null ? "–" : `${Math.round(value)}`);

export function table(title, rows) {
  const lines = [`### ${title}`, "", "| Segment | n | median ms | p95 ms | range ms |", "| --- | ---: | ---: | ---: | ---: |"];
  for (const row of rows) lines.push(`| ${row.label} | ${row.n} | ${ms(row.median)} | ${ms(row.p95)} | ${ms(row.min)}–${ms(row.max)} |`);
  return lines.join("\n");
}

export function fixtureEnvironment({ base = process.env, home, dataDir, serverPort, timelineFile }) {
  const env = { ...base };
  for (const key of [...ISOLATED_DELETIONS, LIVE_DATA_ENV, "LATERDOG_USER_DATA", "ELECTRON_RUN_AS_NODE", "LATERDOG_DESKTOP_PARENT", "LATERDOG_DESKTOP_PROFILE", "LATERDOG_STATIC_DIR", LAUNCH_TIMELINE_ENV]) delete env[key];
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    LATERDOG_HOME: dataDir,
    LATERDOG_BRIDGE_DIR: join(dataDir, "bridge"),
    LATERDOG_SERVER_PORT: String(serverPort),
    LATERDOG_BIND: "127.0.0.1",
    LATERDOG_VARIANT: DEV,
    LATERDOG_APP_VARIANT: DEV,
    LATERDOG_TRIAL_API: "off",
    LATERDOG_LICENSE_KEY: "ld1.not.real",
    ELECTRON_START_URL: `http://127.0.0.1:${serverPort}`,
  });
  if (timelineFile) env[LAUNCH_TIMELINE_ENV] = timelineFile;
  return env;
}

const pause = (wait) => new Promise((done) => setTimeout(done, wait));

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((done) => child.once("exit", () => done()));
}

async function stop(child, graceMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return "already";
  child.kill("SIGTERM");
  const outcome = await Promise.race([exited(child).then(() => "stopped"), pause(graceMs).then(() => "killed")]);
  if (outcome === "killed") {
    child.kill("SIGKILL");
    await exited(child);
  }
  return outcome;
}

async function waitForFile(file, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    if (child.exitCode !== null || child.signalCode !== null) return existsSync(file);
    await pause(50);
  }
  return false;
}

async function launchOnce({ fixture, serverPort, index, kind, electronFile, electronArgs, settleMs, timeoutMs, logs }) {
  const timelineFile = join(fixture.root, "timelines", `${kind}-${index}.json`);
  mkdirSync(dirname(timelineFile), { recursive: true });
  const env = fixtureEnvironment({ home: fixture.home, dataDir: fixture.dataDir, serverPort, timelineFile });
  const log = (name) => join(logs, `${kind}-${index}-${name}.log`);
  const output = (name) => {
    const chunks = [];
    return { chunks, write: (chunk) => chunks.push(chunk), flush: () => writeFileSync(log(name), Buffer.concat(chunks)) };
  };
  const serverOut = output("server");
  const serverSpawnedAt = Date.now();
  const server = spawn(process.execPath, [join(projectRoot, "dist-server", "index.js")], {
    cwd: projectRoot,
    env: { ...env, LATERDOG_STATIC_DIR: join(projectRoot, "dist") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", serverOut.write);
  server.stderr.on("data", serverOut.write);
  let electron = null;
  const electronOut = output("electron");
  try {
    const identity = await pollServerIdentity({ port: serverPort, pid: () => server.pid, bootTimeoutMs: 60_000, isExited: () => server.exitCode !== null });
    if (identity.outcome !== "ready") return { kind, index, failed: `fixture server ${identity.outcome}` };
    const serverBootMs = Date.now() - serverSpawnedAt;
    const spawnedAt = performance.timeOrigin + performance.now();
    electron = spawn(electronFile, [...electronArgs, projectRoot], { cwd: projectRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    electron.stdout.on("data", electronOut.write);
    electron.stderr.on("data", electronOut.write);
    const written = await waitForFile(timelineFile, electron, timeoutMs);
    if (!written) return { kind, index, failed: "no timeline before the timeout", serverBootMs };
    const report = JSON.parse(readFileSync(timelineFile, "utf8"));
    if (report.outcome !== "complete") return { kind, index, failed: `timeline ${report.outcome}`, serverBootMs, spawnedAt, report };
    await pause(settleMs);
    const quit = await stop(electron, 15_000);
    if (quit === "killed") return { kind, index, failed: "the app did not quit within 15 s", serverBootMs, spawnedAt, report };
    return { kind, index, serverBootMs, spawnedAt, report: JSON.parse(readFileSync(timelineFile, "utf8")) };
  } finally {
    await stop(electron, 15_000);
    await stop(server, 10_000);
    electronOut.flush();
    serverOut.flush();
  }
}

function newFixture(parent, name) {
  const root = join(parent, name);
  const fixture = { root, home: join(root, "home"), dataDir: join(root, "data") };
  mkdirSync(fixture.home, { recursive: true });
  mkdirSync(fixture.dataDir, { recursive: true });
  return fixture;
}

function machine() {
  const cores = cpus();
  return { platform: process.platform, release: release(), cpu: cores[0]?.model ?? "unknown", cores: cores.length, memoryGb: Math.round(totalmem() / 2 ** 30), node: process.version };
}

function snapshotSeen(run) {
  return run.report?.marks?.find((entry) => entry.name === "renderer-started")?.detail?.snapshot ?? null;
}

async function main() {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: "10" },
      settle: { type: "string", default: "2500" },
      timeout: { type: "string", default: "90000" },
      out: { type: "string" },
      keep: { type: "boolean", default: false },
    },
  });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs takes a whole number of launches per kind.");
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !process.env.LATERDOG_TIMELINE_UNDER_XVFB) {
    const xvfb = spawnSync("xvfb-run", ["-a", "-s", "-screen 0 1920x1080x24", process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, LATERDOG_TIMELINE_UNDER_XVFB: "1" },
    });
    if (xvfb.error) throw new Error(`No display and xvfb-run is unavailable: ${xvfb.error.message}`);
    process.exit(xvfb.status ?? 1);
  }
  for (const needed of [join(projectRoot, "dist", "index.html"), join(projectRoot, "dist-server", "index.js")]) {
    if (!existsSync(needed)) throw new Error(`${needed} is missing. Run pnpm exec vite build and pnpm build:server first.`);
  }
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "laterdog-launch-timeline-")));
  const refused = refusal({ dataRoot: parent });
  if (refused) {
    rmSync(parent, { recursive: true, force: true });
    throw new Error(refused);
  }
  const busy = [];
  for (const port of protectedPorts()) if (!(await portFree(port))) busy.push(port);
  if (busy.length) {
    rmSync(parent, { recursive: true, force: true });
    throw new Error(`A later.dog may be running: ports ${busy.join(", ")} are in use. The unpackaged app talks to port ${describeVariant(DEV).ports.server[0]}, so this runner only measures with every later.dog port free; nothing was stopped.`);
  }
  const serverPort = describeVariant(DEV).ports.server[0];
  const require = createRequire(import.meta.url);
  const electronFile = require("electron");
  const electronArgs = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];
  const logs = join(parent, "logs");
  mkdirSync(logs, { recursive: true });
  const common = { serverPort, electronFile, electronArgs, settleMs: Number(values.settle), timeoutMs: Number(values.timeout), logs };
  console.error(`launch timeline: ${runs} first and ${runs} repeat launches in ${parent}`);
  const repeatFixture = newFixture(parent, "repeat");
  const warm = await launchOnce({ ...common, fixture: repeatFixture, index: 0, kind: "warm-up" });
  if (warm.failed) console.error(`warm-up: ${warm.failed}`);
  const results = { first: [], repeat: [] };
  for (let index = 1; index <= runs; index++) {
    const first = await launchOnce({ ...common, fixture: newFixture(parent, `first-${index}`), index, kind: "first" });
    results.first.push(first);
    const repeat = await launchOnce({ ...common, fixture: repeatFixture, index, kind: "repeat" });
    results.repeat.push(repeat);
    const total = (run) => (run.failed ? `failed: ${run.failed}` : `${Math.round(segmentsOf(run)["total: spawn → message box on screen"])} ms, snapshot ${snapshotSeen(run)}`);
    console.error(`run ${index}/${runs}: first ${total(first)}; repeat ${total(repeat)}`);
  }
  const record = {
    measuredAt: new Date().toISOString(),
    machine: machine(),
    display: process.env.LATERDOG_TIMELINE_UNDER_XVFB ? "xvfb-run (virtual X display)" : (process.env.WAYLAND_DISPLAY ? "wayland" : `X display ${process.env.DISPLAY}`),
    electronArgs,
    command: `node scripts/launch-timeline.mjs ${process.argv.slice(2).join(" ")}`.trim(),
    results,
    summary: { first: summarize(results.first.filter((run) => !run.failed)), repeat: summarize(results.repeat.filter((run) => !run.failed)) },
    failures: [...results.first, ...results.repeat].filter((run) => run.failed).map(({ kind, index, failed }) => ({ kind, index, failed })),
    snapshots: { first: results.first.map(snapshotSeen), repeat: results.repeat.map(snapshotSeen) },
  };
  if (values.out) writeFileSync(values.out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(table("First launch (no first-paint snapshot)", record.summary.first));
  console.log("");
  console.log(table("Repeat launch (snapshot present)", record.summary.repeat));
  if (record.failures.length) console.log(`\nFailed runs (not averaged in): ${JSON.stringify(record.failures)}`);
  if (values.keep) console.error(`kept ${parent}`);
  else rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
