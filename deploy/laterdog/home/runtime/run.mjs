import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { seedIncluded } from "./included.mjs";
import { RESTORE_POINTS, appRelease, upgradeFrom, upgradeKeeper } from "./restore-points.mjs";
import { FINAL_SAVE_MS, collectGarbage, createHttpStore, restore, settleWithin, snapshot } from "./sync.mjs";

const DATA = process.env.HOME || "/data";
const SCRATCH = "/tmp/laterdog-sync";
const LAUNCHER = "/app/dist-server/cloud-home-start.js";
const INTERVAL_MS = Number(process.env.LATERDOG_SYNC_INTERVAL_MS || 60_000);
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
  const child = spawn(process.execPath, [LAUNCHER], { stdio: "inherit", env: environment });
  let running = null;
  let saves = 0;
  const restorePoints = upgradeKeeper(store, upgraded, { app: APP, limit: KEPT_RESTORE_POINTS, log });
  const save = ({ final = false } = {}) => {
    if (!store) return Promise.resolve();
    if (running) return running;
    running = restorePoints.keep()
      .then(() => snapshot(DATA, store, manifest, { scratch: SCRATCH, app: APP }))
      .then(async (result) => {
        manifest = result.manifest;
        if (result.written) log(`saved (${result.uploaded} changed files)`);
        if (result.unsaved.length) log(`could not save ${result.unsaved.length} file(s) this time, first ${result.unsaved[0]}; the next save tries again`);
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
  const forward = (signal) => () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGINT", forward("SIGINT"));
  child.on("exit", async (code, signal) => {
    log(`the launcher stopped (exit code ${code ?? "none"}, signal ${signal ?? "none"})`);
    clearInterval(timer);
    const finished = await settleWithin((running ?? Promise.resolve()).then(() => save({ final: true })), FINAL_SAVE_MS);
    if (finished === "late") log(`the last save did not finish within ${FINAL_SAVE_MS / 1000} seconds; stopping anyway`);
    process.exit(code ?? (signal ? 1 : 0));
  });
}

main().catch((error) => {
  log(`could not start: ${error.message}`);
  process.exit(1);
});
