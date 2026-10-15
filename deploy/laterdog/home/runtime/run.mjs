import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { seedIncluded } from "./included.mjs";
import { collectGarbage, createHttpStore, restore, snapshot } from "./sync.mjs";

const DATA = process.env.HOME || "/data";
const WORKSPACE = process.env.LATERDOG_HOME || join(DATA, ".laterdog");
const SCRATCH = "/tmp/laterdog-sync";
const LAUNCHER = "/app/dist-server/cloud-home-start.js";
const INTERVAL_MS = Number(process.env.LATERDOG_SYNC_INTERVAL_MS || 60_000);
const RESTORE_ATTEMPTS = 5;
const GC_EVERY_SAVES = Number(process.env.LATERDOG_GC_EVERY_SAVES || 30);

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
  if (store) {
    const restored = await restoreWithRetries(store, dogOwner());
    manifest = restored.manifest;
    log(restored.manifest ? `restored ${restored.files} files` : "a new home: nothing to restore");
  } else {
    log("no state store: this home keeps nothing across restarts");
  }
  const included = await seedIncluded(WORKSPACE, { key: process.env.LATERDOG_INCLUDED_KEY, api: process.env.LATERDOG_INCLUDED_API }, dogOwner());
  if (included === "seeded") log("included later.dog AI, voice and decisions are ready");
  const environment = { ...process.env };
  delete environment.LATERDOG_STATE_URL;
  delete environment.LATERDOG_STATE_TOKEN;
  delete environment.LATERDOG_SYNC_INTERVAL_MS;
  delete environment.LATERDOG_GC_EVERY_SAVES;
  delete environment.LATERDOG_INCLUDED_KEY;
  delete environment.LATERDOG_INCLUDED_API;
  const child = spawn(process.execPath, [LAUNCHER], { stdio: "inherit", env: environment });
  let running = null;
  let saves = 0;
  const save = ({ final = false } = {}) => {
    if (!store) return Promise.resolve();
    if (running) return running;
    running = snapshot(DATA, store, manifest, { scratch: SCRATCH, workspace: relative(DATA, WORKSPACE) })
      .then(async (result) => {
        manifest = result.manifest;
        if (result.written) log(`saved (${result.uploaded} changed files)`);
        saves += 1;
        if (final || saves % GC_EVERY_SAVES !== 0) return;
        try {
          const removed = await collectGarbage(store, manifest);
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
    clearInterval(timer);
    await running;
    await save({ final: true });
    process.exit(code ?? (signal ? 1 : 0));
  });
}

main().catch((error) => {
  log(`could not start: ${error.message}`);
  process.exit(1);
});
