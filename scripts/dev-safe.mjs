import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_DATA_FLAG, SCRIPT_DEFAULTS, scriptTarget } from "../electron/app-variant.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const LEGACY_SERVER_PORT = 8799;
export const ISOLATED_DELETIONS = [
  "LATERDOG_URL",
  "LATERDOG_SUPERVISOR_URL",
  "LATERDOG_TOKEN",
  "LATERDOG_TOKEN_FILE",
  "LATERDOG_DATA_DIR",
  "LATERDOG_HARNESS_URL",
  "LATERDOG_COMPANION_DIR",
  "LATERDOG_WEBHOOK_PORT",
];
const LEGACY_UI_PORT = 5199;

export function safeTarget({ argv = process.argv, env = process.env, home = homedir() } = {}) {
  const target = scriptTarget({ argv, env, home });
  if (target.refusal) throw new Error(target.refusal);
  return target;
}

export function commandContext(command, { argv = process.argv, env = process.env, home = homedir() } = {}) {
  if (command !== "dev") {
    return { isolated: false, target: null, env: { ...env }, dataRoot: env.LATERDOG_HOME ?? join(home, ".laterdog"), supervisorUrl: "http://127.0.0.1:9010" };
  }
  const target = safeTarget({ argv, env, home });
  return { isolated: true, target, env: scriptEnvironment(target, env), dataRoot: target.home, supervisorUrl: `http://127.0.0.1:${target.supervisorPort ?? 9010}` };
}

export function withoutLiveFlag(argv) {
  return argv.filter((argument) => argument !== LIVE_DATA_FLAG);
}

export function banner(target, home = homedir()) {
  if (target.live) {
    return [
      "",
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      `!! ${LIVE_DATA_FLAG}`,
      `!! This run uses your LIVE later.dog data: ${target.home}`,
      "!! Dogs, chats and routines here are the real ones.",
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      "",
    ].join("\n");
  }
  return `later.dog dev script: isolated data in ${target.home.replace(home, "~")}, never your live dogs (${LIVE_DATA_FLAG} to change that).`;
}

export function scriptEnvironment(target, env = process.env) {
  const next = { ...env, LATERDOG_HOME: target.home };
  if (target.serverPort) next.LATERDOG_SERVER_PORT = String(target.serverPort);
  if (target.supervisorPort) next.LATERDOG_PORT = String(target.supervisorPort);
  if (target.uiPort) next.LATERDOG_UI_PORT = String(target.uiPort);
  if (!target.live && !env.LATERDOG_BRIDGE_DIR) next.LATERDOG_BRIDGE_DIR = join(target.home, "bridge");
  if (!target.live) {
    for (const name of ISOLATED_DELETIONS) delete next[name];
    next.LATERDOG_APP_VARIANT = "dev";
  }
  return next;
}

export function planCommand(command, target, argv = [], env = process.env) {
  const port = target.serverPort ?? (target.live ? LEGACY_SERVER_PORT : SCRIPT_DEFAULTS.serverPort);
  const environment = { LATERDOG_SERVER_PORT: String(port) };
  if (command === "ui") environment.LATERDOG_UI_PORT = String(Number(env.LATERDOG_UI_PORT) || LEGACY_UI_PORT);
  if (command === "ui") return { steps: [{ file: process.execPath, args: [join(root, "node_modules/vite/bin/vite.js"), ...argv] }], environment };
  if (command === "server") return { steps: [{ file: process.execPath, args: ["--experimental-strip-types", join(root, "server/index.ts"), ...argv] }], environment };
  if (command === "desktop") {
    return {
      steps: [
        { file: process.execPath, args: [join(root, "scripts/prepare-cloudflared.mjs"), "--current"] },
        { file: join(root, "node_modules/.bin/electron"), args: [".", ...argv] },
      ],
      environment: { ...environment, LATERDOG_VARIANT: target.live ? "release" : "dev" },
    };
  }
  throw new Error("Use ui, server or desktop.");
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  let target;
  try {
    target = safeTarget();
    const plan = planCommand(command, target, withoutLiveFlag(rest));
    console.error(banner(target));
    const env = { ...scriptEnvironment(target), ...plan.environment };
    for (const [index, step] of plan.steps.entries()) {
      const last = index === plan.steps.length - 1;
      if (!last) {
        const done = spawnSync(step.file, step.args, { cwd: root, env, stdio: "inherit" });
        if (done.status !== 0) process.exit(done.status ?? 1);
        continue;
      }
      const child = spawn(step.file, step.args, { cwd: root, env, stdio: "inherit" });
      for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
      child.on("exit", (code, signalName) => process.exit(signalName ? 1 : code ?? 0));
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
