import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { devCodeWatcher } from "./dev-code.mjs";
import { seedIncluded } from "./included.mjs";
import { RESTORE_POINTS, appRelease, upgradeFrom, upgradeKeeper } from "./restore-points.mjs";
import { FINAL_SAVE_MS, collectGarbage, createHttpStore, restore, settleWithin, snapshot } from "./sync.mjs";

const DATA = process.env.HOME || "/data";
const SCRATCH = "/tmp/laterdog-sync";
const SERVER_DIR = "/app/dist-server";
const LAUNCHER = join(SERVER_DIR, "cloud-home-start.js");
const DEV_CODE_DIR = "/tmp/laterdog-dev-server";
const STOP_CHILD_MS = 20_000;
const PUSHED_CODE_GRACE_MS = 30_000;
const INTERVAL_MS = Number(process.env.LATERDOG_SYNC_INTERVAL_MS || 60_000);
const SAVE_BUDGET_MS = Math.max(5_000, INTERVAL_MS - 15_000);
const FINAL_SAVE_BUDGET_MS = FINAL_SAVE_MS - 30_000;
const RESTORE_ATTEMPTS = 5;
const GC_EVERY_SAVES = Number(process.env.LATERDOG_GC_EVERY_SAVES || 30);
const KEPT_RESTORE_POINTS = Number(process.env.LATERDOG_RESTORE_POINTS || RESTORE_POINTS);
const APP = appRelease();

function log(message) {
  process.stderr.write(`laterdog home: ${message}\n`);
}

function dogOwner() {
  for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
    const [user, , uid, gid] = line.split(":");
    if (user === "dog") return { uid: Number(uid), gid: Number(gid) };
  }
  throw new Error("the dog user is missing from this image");
}

async function restoreWithRetries(store, owner) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await restore(DATA, store, owner);
    } catch (error) {
      if (attempt >= RESTORE_ATTEMPTS) throw error;
      log(`restore attempt ${attempt} failed: ${error.message}; trying again`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
}

async function main() {
  const url = process.env.LATERDOG_STATE_URL;
  const token = process.env.LATERDOG_STATE_TOKEN;
  const store = url && token ? createHttpStore(url, token) : null;
  let manifest = null;
  let upgraded = null;
  if (store) {
    const restored = await restoreWithRetries(store, dogOwner());
    manifest = restored.manifest;
    upgraded = upgradeFrom(manifest, APP);
    log(restored.manifest ? `restored ${restored.files} files` : "a new home: nothing to restore");
    if (upgraded) log(`${APP} replaces ${upgraded.app ?? "an earlier version"}; keeping a restore point before the first save`);
  } else {
    log("no state store: this home keeps nothing across restarts");
  }
  const included = await seedIncluded(process.env.LATERDOG_HOME || join(DATA, ".laterdog"), { key: process.env.LATERDOG_INCLUDED_KEY, api: process.env.LATERDOG_INCLUDED_API }, dogOwner());
  if (included === "seeded" || included === "replaced") log("included later.dog AI, voice and decisions are ready");
  const environment = { ...process.env };
  delete environment.LATERDOG_STATE_URL;
  delete environment.LATERDOG_STATE_TOKEN;
  delete environment.LATERDOG_SYNC_INTERVAL_MS;
  delete environment.LATERDOG_GC_EVERY_SAVES;
  delete environment.LATERDOG_RESTORE_POINTS;
  delete environment.LATERDOG_INCLUDED_KEY;
  delete environment.LATERDOG_INCLUDED_API;
  const devCode = store && process.env.LATERDOG_DEV_CODE === "1"
    ? devCodeWatcher({ store, base: SERVER_DIR, root: DEV_CODE_DIR, log, onCode: (next) => reload(next) })
    : null;
  const pushed = devCode ? await devCode.first() : null;
  if (pushed) log(`running pushed server code ${pushed.hash.slice(0, 12)}${pushed.label ? ` (${pushed.label})` : ""}`);
  let launcher = pushed?.launcher ?? LAUNCHER;
  let child = null;
  let reloading = false;
  let running = null;
  let saves = 0;
  const restorePoints = upgradeKeeper(store, upgraded, { app: APP, limit: KEPT_RESTORE_POINTS, log });
  const save = ({ final = false } = {}) => {
    if (!store) return Promise.resolve();
    if (running) return running;
    running = restorePoints.keep()
      .then(() => snapshot(DATA, store, manifest, { scratch: SCRATCH, app: APP, budgetMs: final ? FINAL_SAVE_BUDGET_MS : SAVE_BUDGET_MS }))
      .then(async (result) => {
        manifest = result.manifest;
        if (result.written) log(`saved (${result.uploaded} changed files)`);
        if (result.unsaved.length) log(`could not save ${result.unsaved.length} file(s) this time, first ${result.unsaved[0]}; the next save tries again`);
        if (result.deferred) log(`${result.deferred} changed file(s) wait for the next save, which carries on where this one stopped`);
        saves += 1;
        if (final || saves % GC_EVERY_SAVES !== 0) return;
        try {
          const removed = await collectGarbage(store, manifest, { pending: restorePoints.pending() });
          if (removed) log(`removed ${removed} saved pieces nothing uses any more`);
        } catch (error) {
          log(`cleanup failed: ${error.message}`);
        }
      })
      .catch((error) => log(`save failed: ${error.message}`))
      .finally(() => {
        running = null;
      });
    return running;
  };
  const timer = setInterval(() => void save(), INTERVAL_MS);
  const alive = () => child && child.exitCode === null && child.signalCode === null;
  const forward = (signal) => () => {
    reloading = false;
    if (alive()) child.kill(signal);
  };
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGINT", forward("SIGINT"));
  let startedAt = 0;
  const stopped = async (code, signal) => {
    if (reloading) return;
    if (launcher !== LAUNCHER && code !== 0 && Date.now() - startedAt < PUSHED_CODE_GRACE_MS) {
      log(`the pushed server code stopped right away (exit code ${code ?? "none"}, signal ${signal ?? "none"}); going back to this image's server`);
      launcher = LAUNCHER;
      start();
      return;
    }
    log(`the launcher stopped (exit code ${code ?? "none"}, signal ${signal ?? "none"})`);
    clearInterval(timer);
    devCode?.stop();
    const finished = await settleWithin((running ?? Promise.resolve()).then(() => save({ final: true })), FINAL_SAVE_MS);
    if (finished === "late") log(`the last save did not finish within ${FINAL_SAVE_MS / 1000} seconds; stopping anyway`);
    process.exit(code ?? (signal ? 1 : 0));
  };
  const start = () => {
    startedAt = Date.now();
    child = spawn(process.execPath, [launcher], { stdio: "inherit", env: environment });
    child.on("exit", stopped);
  };
  const reload = async (next) => {
    reloading = true;
    const previous = child;
    const exited = new Promise((resolve) => previous.once("exit", resolve));
    if (alive()) previous.kill("SIGTERM");
    const late = setTimeout(() => { if (previous.exitCode === null) previous.kill("SIGKILL"); }, STOP_CHILD_MS);
    await exited;
    clearTimeout(late);
    if (!reloading) return;
    await (running ?? Promise.resolve()).then(() => save());
    launcher = next.launcher;
    reloading = false;
    log(`running pushed server code ${next.hash.slice(0, 12)}${next.label ? ` (${next.label})` : ""}`);
    start();
  };
  start();
  devCode?.start();
}

main().catch((error) => {
  log(`could not start: ${error.message}`);
  process.exit(1);
});
