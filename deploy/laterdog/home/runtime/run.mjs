import { folderExclusions, folderMounts, legacyWorkFolderScope, startWorkFolderMounts } from "./work-folder-mounts.mjs";
import { projectPreviousCloudBackup } from "./previous-backup-compat.mjs";
import { randomBytes } from "node:crypto";
import { createArchiver, serveArchive } from "./archive.mjs";
import { launcherOwnsNoFile } from "./archive-launcher.mjs";
import { archiveCompatible } from "./archive-capability.mjs";
import { fileIsUnopened } from "./archive-ownership.mjs";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { devCodeWatcher, homeIdle } from "./dev-code.mjs";
import { CLOUD_HOME_MARKER, noteHomeHealth, outputTail, pushedCodeFellBack, shouldFallBackFromPushed } from "./home-health.mjs";
import { seedIncluded } from "./included.mjs";
import { SAVE_STATUS_PATH, saveRecorder, slowCopies, writeSaveStatus } from "./save-status.mjs";
import { RESTORE_POINTS, appRelease, upgradeFrom, upgradeKeeper } from "./restore-points.mjs";
import { FINAL_SAVE_MS, collectGarbageWithin, createHttpStore, settleWithin, snapshot } from "./sync.mjs";
import { restoredFirst, restoresLater, startRestore } from "./restore-engine.mjs";
import { restoreUntilDone } from "./restore-until-done.mjs";
import { switchLauncher } from "./launcher-switch.mjs";
import { holdStopsWhileRestoring } from "./restore-signals.mjs";

const DATA = process.env.HOME || "/data";
const SCRATCH = "/tmp/laterdog-sync";
const MEMORY_SCRATCH = "/run/laterdog-sync";
const SERVER_DIR = "/app/dist-server";
const LAUNCHER = join(SERVER_DIR, "cloud-home-start.js");
const DEV_CODE_DIR = "/tmp/laterdog-dev-server";
const HEALTH_DIR = process.env.LATERDOG_HOME || join(process.env.HOME || "/data", ".laterdog");
const SERVER_PORT = Number(process.env.LATERDOG_SERVER_PORT || 8799);
const PUSHED_CODE_GRACE_MS = 30_000;
const INTERVAL_MS = Number(process.env.LATERDOG_SYNC_INTERVAL_MS || 60_000);
const SAVE_BUDGET_MS = Math.max(5_000, INTERVAL_MS - 15_000);
const FINAL_SAVE_BUDGET_MS = FINAL_SAVE_MS - 30_000;
const GC_EVERY_SAVES = Number(process.env.LATERDOG_GC_EVERY_SAVES || 30);
const CLEANUP_BUDGET_MS = 15_000;
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

async function main() {
  const url = process.env.LATERDOG_STATE_URL;
  const token = process.env.LATERDOG_STATE_TOKEN;
  const store = url && token ? createHttpStore(url, token) : null;
  const placement = store ? await store.workFolderPlacement() : null;
  const mounts = folderMounts(DATA, placement);
  const capabilities = { workFolders: mounts.length > 0 };
  const exclude = mounts.length ? folderExclusions(mounts) : undefined;
  const exactScope = legacyWorkFolderScope(DATA, placement);
  let manifest = null;
  let upgraded = null;
  let restoring = null;
  if (store) {
    const restoreStore = placement?.mode === "folders" ? { ...store, async manifest() {
      const current = await store.manifest();
      return current && projectPreviousCloudBackup(current, placement);
    } } : store;
    const owner = dogOwner();
    const held = holdStopsWhileRestoring({ log });
    const read = await restoreUntilDone(async () => ({ manifest: await restoreStore.manifest() }), { log });
    manifest = read.manifest;
    restoring = manifest ? startRestore({ root: DATA, manifest, pieces: store.pieces, owner, exclude, exactScope, later: restoresLater(), scratch: MEMORY_SCRATCH, log }) : null;
    const booted = restoring ? await restoring.boot : null;
    const signalled = held.release();
    upgraded = upgradeFrom(manifest, APP);
    const restoredLine = booted ? `restored ${booted.files} files needed to start in ${Math.round(booted.ms / 1000)} s after ${booted.attempts} attempt(s); ${restoring.pending().size} more come back while the home serves` : "a new home: nothing to restore";
    log(restoredLine);
    for (const note of [...read.notes, ...(booted?.notes ?? []), ...signalled.map(({ signal, at }) => `${signal} arrived ${Math.round((at - Date.now() + read.ms + (booted?.ms ?? 0)) / 1000)} s into the restore and was held until it finished`), restoredLine]) noteHomeHealth(HEALTH_DIR, note, { owner, home: DATA });
    restoring?.done.then((all) => {
      const line = `restored all ${all.files} files (${Math.round(all.bytes / 1e6)} MB) in ${Math.round(all.ms / 1000)} s, peak engine memory ${Math.round(all.peakMemoryBytes / 1e6)} MB${all.kept.length ? `; kept the newer copy the home wrote of ${all.kept.length} file(s), first ${all.kept[0]}` : ""}`;
      log(line);
      noteHomeHealth(HEALTH_DIR, line, { owner, home: DATA });
    }, () => {});
    if (upgraded) log(`${APP} replaces ${upgraded.app ?? "an earlier version"}; keeping a restore point before the first save`);
  } else {
    log("no state store: this home keeps nothing across restarts");
  }
  const included = await seedIncluded(process.env.LATERDOG_HOME || join(DATA, ".laterdog"), { key: process.env.LATERDOG_INCLUDED_KEY, api: process.env.LATERDOG_INCLUDED_API }, dogOwner());
  if (included === "seeded" || included === "replaced") log("included later.dog AI, voice and decisions are ready");
  if (store && !await archiveCompatible(LAUNCHER, capabilities)) throw new Error("the image cannot serve the active home storage format");
  const environment = { ...process.env };
  const archiveCodexSessions = process.env.LATERDOG_ARCHIVE_CODEX_SESSIONS === "1";
  const archiver = store ? createArchiver({ root: DATA, store, owner: dogOwner(), log, archiveCodexSessions, canRemove: async (file, entry) => {
    const launcher = child;
    if (!await launcherOwnsNoFile(launcher, entry)) return false;
    const clear = await fileIsUnopened(file, { asOwner: dogOwner(), launcherPid: launcher.pid, maxDescriptors: 50_000 });
    return clear && launcher === child && launcher.exitCode === null && launcher.signalCode === null;
  } }) : null;
  const archive = archiver ? await serveArchive(restoring ? restoredFirst(archiver, restoring) : archiver, { token: environment.LATERDOG_CLOUD_ARCHIVE_TOKEN = randomBytes(32).toString("hex") }) : null;
  if (archive) environment.LATERDOG_CLOUD_ARCHIVE_URL = archive.url;
  delete environment.LATERDOG_STATE_URL;
  delete environment.LATERDOG_STATE_TOKEN;
  delete environment.LATERDOG_SYNC_INTERVAL_MS;
  delete environment.LATERDOG_GC_EVERY_SAVES;
  delete environment.LATERDOG_RESTORE_POINTS;
  delete environment.LATERDOG_INCLUDED_KEY;
  delete environment.LATERDOG_INCLUDED_API;
  const devCode = store && process.env.LATERDOG_DEV_CODE === "1"
    ? devCodeWatcher({ store, base: SERVER_DIR, root: DEV_CODE_DIR, log, onCode: (next) => reload(next), idle: () => homeIdle({ secret: process.env.LATERDOG_CLOUD_BOOTSTRAP_SECRET, port: SERVER_PORT }) })
    : null;
  const offered = devCode ? await devCode.first() : null;
  const pushed = offered && (!archive || await archiveCompatible(offered.launcher, capabilities)) ? offered : null;
  if (offered && !pushed) log("the pushed server cannot serve the active home storage format; using this image");
  if (pushed) log(`running pushed server code ${pushed.hash.slice(0, 12)}${pushed.label ? ` (${pushed.label})` : ""}`);
  let launcher = pushed?.launcher ?? LAUNCHER;
  let child = null;
  const folderMount = await startWorkFolderMounts({ home: DATA, placement, mounts, owner: dogOwner(), server: SERVER_DIR,
    onLost: () => { log("Work folder transport stopped; restarting the coordinator."); if (child) child.kill("SIGTERM"); else process.exit(1); },
  });
  if (folderMount) {
    environment.LATERDOG_WORK_FOLDER_LAYOUT = folderMount.file;
    environment.LATERDOG_WORK_FOLDER_CHECKPOINT_SOCKET = folderMount.checkpoint;
  }
  let reloading = false;
  let running = null;
  let saves = 0;
  let cleanupLeft = false;
  let resumeAfter;
  const restorePoints = upgradeKeeper(store, upgraded, { app: APP, limit: KEPT_RESTORE_POINTS, log });
  const saveStatus = saveRecorder({ write: (status) => writeSaveStatus(SAVE_STATUS_PATH, status) });
  let restoredAll = !restoring;
  const save = ({ final = false } = {}) => {
    if (!store || (!final && !restoredAll) || !existsSync(join(DATA, CLOUD_HOME_MARKER))) return Promise.resolve();
    if (running) return running;
    running = restorePoints.keep()
      .then(() => {
        void saveStatus.started({ final });
        return snapshot(DATA, store, manifest, { scratch: SCRATCH, memoryScratch: MEMORY_SCRATCH, onCopy: (copy) => void saveStatus.copying(copy), exclude, exactScope, carry: restoring && new Map(restoring.pending()), app: APP, budgetMs: final ? FINAL_SAVE_BUDGET_MS : SAVE_BUDGET_MS, resumeAfter });
      })
      .then(async (result) => {
        void saveStatus.finished(result);
        for (const line of slowCopies(result.copies)) log(line);
        manifest = result.manifest;
        resumeAfter = result.resumeAfter;
        if (result.written) log(`saved (${result.uploaded} changed files)`);
        if (result.unsaved.length) log(`could not save ${result.unsaved.length} file(s) this time, first ${result.unsaved[0]} (${result.unsavedReason}); the next save tries again`);
        if (result.deferred) log(`${result.deferred} changed file(s) wait for the next save, which carries on where this one stopped`);
        saves += 1;
        if (final || (!cleanupLeft && saves % GC_EVERY_SAVES !== 0)) return;
        try {
          const cleanup = await collectGarbageWithin(store, manifest, { pending: restorePoints.pending(), budgetMs: CLEANUP_BUDGET_MS });
          cleanupLeft = !cleanup.finished;
          if (cleanup.removed) log(`removed ${cleanup.removed} saved pieces nothing uses any more${cleanupLeft ? "; the next save removes more" : ""}`);
        } catch (error) {
          log(`cleanup failed: ${error.message}`);
        }
      })
      .catch((error) => {
        void saveStatus.failed(error);
        log(`save failed: ${error.message}`);
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  restoring?.done.then(() => {
    restoredAll = true;
    void save();
  }, () => {});
  const timer = setInterval(() => void save(), INTERVAL_MS);
  const alive = () => child && child.exitCode === null && child.signalCode === null;
  let stopping = false;
  let shuttingDown = null;
  const shutdown = (code, signal) => {
    stopping = true;
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      clearInterval(timer);
      devCode?.stop();
      await archive?.close();
      await restoring?.stop();
      const finished = await settleWithin((running ?? Promise.resolve()).then(() => save({ final: true })), FINAL_SAVE_MS);
      if (finished === "late") log(`the last save did not finish within ${FINAL_SAVE_MS / 1000} seconds; stopping anyway`);
      await folderMount?.stop();
      process.exit(code ?? (signal ? 1 : 0));
    })();
    return shuttingDown;
  };
  const forward = (signal) => () => {
    stopping = true;
    reloading = false;
    if (alive()) child.kill(signal);
  };
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGINT", forward("SIGINT"));
  let startedAt = 0;
  const stderrTail = outputTail();
  const stopped = async (code, signal) => {
    if (reloading) return;
    if (launcher !== LAUNCHER && shouldFallBackFromPushed({ stopping, code, signal, elapsedMs: Date.now() - startedAt, graceMs: PUSHED_CODE_GRACE_MS })) {
      const said = pushedCodeFellBack({ code, signal, tail: stderrTail.text() });
      log(said);
      noteHomeHealth(HEALTH_DIR, said, { owner: dogOwner(), home: DATA });
      launcher = LAUNCHER;
      start();
      return;
    }
    log(`the launcher stopped (exit code ${code ?? "none"}, signal ${signal ?? "none"})`);
    await shutdown(code, signal);
  };
  const start = () => {
    startedAt = Date.now();
    stderrTail.clear();
    child = spawn(process.execPath, [launcher], { stdio: ["inherit", "inherit", "pipe", "ipc"], env: environment });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderrTail.push(chunk);
    });
    child.on("exit", stopped);
  };
  const reload = async (next) => {
    if (stopping) return;
    if (archive && !await archiveCompatible(next.launcher, capabilities)) {
      log("the pushed server cannot serve the active home storage format; keeping the current server");
      return;
    }
    if (stopping || !alive()) return;
    reloading = true;
    const switched = await switchLauncher({
      previous: child,
      carryOn: () => !stopping && reloading,
      start: () => {
        launcher = next.launcher;
        reloading = false;
        log(`running pushed server code ${next.hash.slice(0, 12)}${next.label ? ` (${next.label})` : ""}`);
        start();
      },
      save: () => (running ?? Promise.resolve()).then(() => save()),
    });
    if (!switched && stopping) await shutdown(0, null);
  };
  start();
  devCode?.start();
}

main().catch((error) => {
  log(`could not start: ${error.message}`);
  process.exit(1);
});
