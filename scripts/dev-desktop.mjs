import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeVariant, LIVE_DATA_ENV, LIVE_DATA_FLAG, ownedPorts } from "../electron/app-variant.mjs";
import { READY_PATH } from "./dev-home-proxy.mjs";
import { safeTarget, scriptEnvironment } from "./dev-safe.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function runtimeBinary(home = homedir()) {
  if (Number(process.versions.node.split(".")[0]) >= 24) return process.execPath;
  const folder = join(home, ".nvm", "versions", "node");
  const versions = existsSync(folder) ? readdirSync(folder).filter(value => /^v\d+\./.test(value) && Number(value.slice(1).split(".")[0]) >= 24).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) : [];
  if (!versions.length) throw new Error("later.dog Dev needs Node 24 or newer. Install Node 24 and run pnpm dev:desktop again.");
  return join(folder, versions[0], "bin", "node");
}

export function desktopPlan({ env = process.env, home = homedir(), root = projectRoot, node = process.execPath } = {}) {
  if (env[LIVE_DATA_ENV] === "1") throw new Error("The hot-reload desktop cannot use live data. Remove LATERDOG_USE_MY_LIVE_DOGS.");
  const dev = describeVariant("dev");
  const uiPort = Number(env.LATERDOG_UI_PORT || 5299);
  if (!Number.isInteger(uiPort) || uiPort < 1024 || uiPort > 65535 || ownedPorts(describeVariant("release")).has(uiPort) || ownedPorts(dev).has(uiPort)) throw new Error("Choose an unused non-release UI port between 1024 and 65535.");
  const target = safeTarget({ argv: [], home, env: { ...env, LATERDOG_HOME: env.LATERDOG_HOME || join(home, dev.dataDirName), LATERDOG_SERVER_PORT: String(dev.ports.server[0]), LATERDOG_PORT: String(dev.ports.supervisor), LATERDOG_UI_PORT: String(uiPort) } });
  const serverUrl = `http://127.0.0.1:${target.serverPort}`;
  const supervisorUrl = `http://127.0.0.1:${target.supervisorPort}`;
  const uiUrl = `http://127.0.0.1:${uiPort}`;
  const isolated = scriptEnvironment(target, env);
  for (const key of ["LATERDOG_USER_DATA", "ELECTRON_RUN_AS_NODE", "ELECTRON_START_URL", "LATERDOG_DESKTOP_PARENT", "LATERDOG_DESKTOP_PROFILE"]) delete isolated[key];
  const environment = { ...isolated, PATH: `${dirname(node)}${delimiter}${env.PATH ?? ""}`, LATERDOG_VARIANT: "dev", LATERDOG_USER_DATA: join(target.home, "desktop"), LATERDOG_BRIDGE_DIR: join(target.home, "bridge"), LATERDOG_BIND: "127.0.0.1", ELECTRON_START_URL: uiUrl, LATERDOG_WORKSPACE_URL: serverUrl };
  const step = (...args) => ({ file: node, args });
  const electron = process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron";
  const vite = step(join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(uiPort), "--strictPort");
  const electronFile = env.LATERDOG_DEV_ELECTRON?.trim() || join(root, "node_modules/electron/dist", electron);
  const homeSession = env.LATERDOG_DEV_HOME_SESSION?.trim();
  if (homeSession) {
    const proxyPort = target.serverPort;
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    return {
      root, node, env: { ...environment, LATERDOG_DEV_API_URL: proxyUrl, LATERDOG_WORKSPACE_URL: proxyUrl }, ports: [proxyPort, uiPort], serverUrl: proxyUrl, readyUrl: `${proxyUrl}${READY_PATH}`, supervisorUrl: null, uiUrl, homeSession,
      services: [
        step(join(root, "scripts/dev-home-proxy.mjs"), homeSession, String(proxyPort)),
        vite,
        { ...step(join(root, "scripts/dev-mac.mjs"), homeSession, target.home), optional: true },
        { ...step(join(root, "scripts/dev-home.mjs"), "watch", "--session", homeSession), optional: true },
      ],
      electron: { file: electronFile, args: [root] },
    };
  }
  return {
    root, node, env: environment, ports: [target.serverPort, target.serverPort + 1, target.supervisorPort, uiPort], serverUrl, supervisorUrl, uiUrl,
    services: [step(join(root, "server/laterdog/main.ts")), step(join(root, "server/index.ts")), vite],
    electron: { file: electronFile, args: [root] },
  };
}

export async function assertPorts(ports) {
  const reservations = [];
  try {
    for (const port of ports) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once("error", () => reject(new Error(`Port ${port} is already in use. Close the other Dev session; no existing process was stopped.`)));
        server.listen({ port, host: "127.0.0.1", exclusive: true }, resolve);
      });
      reservations.push(server);
    }
  } finally {
    await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve))));
  }
}

export async function waitReady(url, signal) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]), redirect: "error" });
      await response.body?.cancel();
      if (response.ok || (response.status === 401 && url.endsWith("/v1/workspace"))) return;
    } catch (error) {
      if (signal.aborted) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Dev startup timed out at ${url}.`);
}

export async function runDesktop(plan, { spawnProcess = spawn, assertPorts: checkPorts = assertPorts, waitReady: ready = waitReady, signals = process } = {}) {
  const children = new Set();
  const abort = new AbortController();
  let stopping = false;
  let exitCode = 0;
  let forceStop;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const finishIfStopped = () => {
    if (stopping && !children.size) { clearTimeout(forceStop); finish(exitCode); }
  };
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    abort.abort();
    for (const child of children) child.kill("SIGTERM");
    forceStop = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 5000);
    forceStop.unref();
    finishIfStopped();
  };
  const interrupted = () => stop(0);
  const launch = (step, transient = false, normalExit = false) => {
    const child = spawnProcess(step.file, step.args, { cwd: plan.root, env: step.env ?? plan.env, stdio: "inherit" });
    children.add(child);
    const closed = new Promise((resolve, reject) => {
      child.once("error", error => { stop(1); reject(error); });
      child.once("close", (code, signal) => {
        children.delete(child);
        if (!transient && !stopping) stop(normalExit ? code ?? (signal ? 1 : 0) : code || 1);
        resolve(code ?? 1);
        finishIfStopped();
      });
    });
    if (!transient) void closed.catch(error => console.error(error.message));
    return closed;
  };
  signals.on("SIGINT", interrupted);
  signals.on("SIGTERM", interrupted);
  try {
    await checkPorts(plan.ports);
    if (stopping) throw new Error("Dev startup cancelled.");
    if (!stopping) for (const service of plan.services) launch(service, service.optional === true);
    if (!stopping) await Promise.all([...(plan.supervisorUrl ? [ready(`${plan.supervisorUrl}/v1/workspace`, abort.signal)] : []), ready(plan.readyUrl ?? `${plan.serverUrl}/api/health`, abort.signal), ready(`${plan.uiUrl}/@vite/client`, abort.signal)]);
    if (!stopping) {
      console.log(`later.dog Dev: ${plan.uiUrl} (renderer hot reload). ${plan.homeSession ? `Home: ${plan.homeSession}` : `Data: ${plan.env.LATERDOG_HOME}`}. Quit the app or press Ctrl-C to stop this session.`);
      launch(plan.electron, false, true);
    }
  } catch (error) {
    if (!stopping) console.error(error.message);
    stop(1);
  }
  try { return await done; } finally {
    signals.off("SIGINT", interrupted);
    signals.off("SIGTERM", interrupted);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.includes(LIVE_DATA_FLAG) || process.argv.length > 2) throw new Error("Run pnpm dev:desktop without live-data flags or extra arguments.");
    process.exitCode = await runDesktop(desktopPlan({ node: runtimeBinary() }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
