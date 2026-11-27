import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { archivable, sessionOf } from "./archive.mjs";
import { restoreBackoff, RESTORE_NOTES_KEPT } from "./restore-until-done.mjs";
import { transient } from "./sync.mjs";

export const ENGINE = process.env.LATERDOG_RESTORE_ENGINE || "/app/cloud/bin/laterdog-restore";
export const RECENT_RUN_MS = 48 * 60 * 60_000;
export const RETRY_LINES_PER_FILE = 3;
const CACHES = /^(?:\.local\/|\.config\/\.wrangler\/|\.laterdog\/attachments\/|\.laterdog\/providers\/(?:[^/]+\/)+(?:cache|plugins)\/)/;
const RUNS = ".laterdog/computer-runs/";
const NEEDLE = /^[A-Za-z0-9_.-]{8,200}$/;

export function restoresLater(now = Date.now()) {
  return (entry) => archivable(entry.path) || CACHES.test(entry.path) || (entry.path.startsWith(RUNS) && entry.mtimeMs < now - RECENT_RUN_MS);
}

function laterOrder(left, right) {
  const rank = (entry) => entry.path.startsWith(".laterdog/attachments/") || entry.path.startsWith(RUNS) ? 0 : archivable(entry.path) ? 1 : 2;
  return rank(left) - rank(right) || right.mtimeMs - left.mtimeMs;
}

function checkedHardLinks(kept, exactScope) {
  const hardLinks = kept.filter((entry) => entry.hardlink !== undefined);
  const byPath = new Map(kept.map((entry) => [entry.path, entry]));
  for (const entry of hardLinks) {
    const original = byPath.get(entry.hardlink);
    if (!exactScope?.(entry.path) || exactScope(entry.path) !== exactScope(entry.hardlink) ||
        !original || original.type !== "file" || entry.type !== "file" || original.hardlink !== undefined ||
        original.mode !== entry.mode || original.mtimeMs !== entry.mtimeMs || original.size !== entry.size ||
        JSON.stringify(original.chunks) !== JSON.stringify(entry.chunks)) throw new Error("Invalid working folder hard link");
    for (const name of [entry.path, original.path]) {
      const fields = name.split("/");
      if (fields.some((part) => !part || part === "." || part === "..")) throw new Error("Invalid working folder hard link path");
      for (let i = 1; i < fields.length; i++) {
        if (byPath.get(fields.slice(0, i).join("/"))?.type !== "dir") throw new Error("Invalid hard link parent");
      }
    }
  }
  return hardLinks;
}

export function restorePlan(manifest, { exclude, exactScope, later = () => false } = {}) {
  const kept = manifest.entries.filter((entry) => !exclude?.(entry.path) && (exactScope?.(entry.path) || !transient(entry)));
  const hardlinks = checkedHardLinks(kept, exactScope);
  const anchored = new Set(hardlinks.map((entry) => entry.hardlink));
  const deferred = (entry) => !anchored.has(entry.path) && !exactScope?.(entry.path) && later(entry);
  const boot = { files: [], links: [], hardlinks };
  const background = { files: [], links: [], hardlinks: [] };
  for (const entry of kept) {
    if (entry.type === "dir" || entry.hardlink !== undefined) continue;
    const phase = deferred(entry) ? background : boot;
    (entry.type === "link" ? phase.links : phase.files).push(entry);
  }
  boot.files.sort((left, right) => (right.size ?? 0) - (left.size ?? 0));
  background.files.sort(laterOrder);
  return { dirs: kept.filter((entry) => entry.type === "dir"), boot, later: background };
}

function engineEnvironment(pieces, parallel, retryMs) {
  const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", LATERDOG_RESTORE_PIECES: pieces.url };
  if (pieces.token) environment.LATERDOG_RESTORE_TOKEN = pieces.token;
  if (parallel) environment.LATERDOG_RESTORE_PARALLEL = String(parallel);
  if (retryMs !== undefined) environment.LATERDOG_RESTORE_RETRY_MS = String(retryMs);
  return environment;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function startRestore({ root, manifest, pieces, owner = null, exclude, exactScope, later, engine = ENGINE, parallel, retryMs, scratch = tmpdir(), log = () => {}, wait = pause, now = Date.now }) {
  if (!pieces?.url) throw new Error("this store cannot hand pieces to the restore engine");
  const plan = restorePlan(manifest, { exclude, exactScope, later });
  const started = now();
  const pending = new Map();
  const bootPending = new Set();
  for (const entry of [...plan.boot.files, ...plan.boot.links, ...plan.boot.hardlinks]) {
    pending.set(entry.path, entry);
    bootPending.add(entry.path);
  }
  for (const entry of [...plan.later.files, ...plan.later.links]) pending.set(entry.path, entry);
  const fileCount = plan.boot.files.length + plan.boot.hardlinks.length + plan.later.files.length;
  const wanted = new Map();
  const notes = [];
  const kept = [];
  const retries = new Map();
  let child = null;
  let stopped = false;
  let attempts = 0;
  let peakMemoryBytes = 0;
  let bytes = 0;
  let settle;
  let settleBoot;
  let fail;
  const done = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
  const boot = new Promise((resolve) => { settleBoot = resolve; });
  done.catch(() => {});
  const bootReady = () => {
    if (bootPending.size === 0) settleBoot({ files: plan.boot.files.length + plan.boot.hardlinks.length, ms: now() - started, attempts, notes: [...notes], peakMemoryBytes });
  };
  const arrived = (path, how) => {
    if (!pending.delete(path)) return;
    if (how === "kept") kept.push(path);
    bootPending.delete(path);
    for (const [waiter, paths] of wanted) {
      paths.delete(path);
      if (paths.size === 0) {
        wanted.delete(waiter);
        waiter();
      }
    }
  };
  const note = (said) => {
    notes.push(said);
    if (notes.length > RESTORE_NOTES_KEPT) notes.shift();
    log(said);
  };
  const phase = (entries, replace) => ({ files: entries.files.filter((entry) => pending.has(entry.path)), links: entries.links.filter((entry) => pending.has(entry.path)), hardlinks: entries.hardlinks.filter((entry) => pending.has(entry.path)), replace });
  const run = async () => {
    while (!stopped) {
      attempts += 1;
      const file = join(scratch, `laterdog-restore-plan-${process.pid}-${attempts}.json`);
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      await writeFile(file, JSON.stringify({ root, owner, dirs: plan.dirs, phases: [{ name: "boot", ...phase(plan.boot, true) }, { name: "later", ...phase(plan.later, false) }] }), { mode: 0o600 });
      let finished = null;
      let failure = null;
      const exited = await new Promise((resolve) => {
        child = spawn(engine, [file], { stdio: ["pipe", "pipe", "inherit"], env: engineEnvironment(pieces, parallel, retryMs) });
        child.stdin.on("error", () => {});
        child.once("error", (error) => { failure = error.message; resolve(null); });
        child.once("exit", (code, signal) => resolve({ code, signal }));
        const paths = [...new Set([...wanted.values()].flatMap((set) => [...set]))];
        if (paths.length) child.stdin.write(`${JSON.stringify({ want: paths })}\n`);
        createInterface({ input: child.stdout }).on("line", (line) => {
          let event;
          try { event = JSON.parse(line); } catch { return; }
          if (typeof event.installed === "string") arrived(event.installed, "installed");
          else if (typeof event.kept === "string") arrived(event.kept, "kept");
          else if (typeof event.retry === "string") {
            const count = (retries.get(event.retry) ?? 0) + 1;
            retries.set(event.retry, count);
            if (count <= RETRY_LINES_PER_FILE) note(`reading ${event.retry} again (piece ${event.piece}, try ${event.attempt}): ${event.error}`);
          } else if (typeof event.error === "string") failure = event.error;
          if (typeof event.peakMemoryBytes === "number") peakMemoryBytes = Math.max(peakMemoryBytes, event.peakMemoryBytes);
          if (typeof event.bytes === "number") bytes = Math.max(bytes, event.bytes);
          if (event.phase === "boot") bootReady();
          if (event.finished) finished = event;
        });
      });
      await rm(file, { force: true });
      child = null;
      await new Promise((resolve) => setImmediate(resolve));
      if (finished && pending.size === 0) {
        bootReady();
        settle({ manifest, files: fileCount, kept, attempts, notes: [...notes], ms: now() - started, bytes, peakMemoryBytes });
        return;
      }
      if (stopped) break;
      note(`restore attempt ${attempts} stopped with ${pending.size} file(s) still to come, ${Math.round((now() - started) / 1000)} s in: ${failure ?? `exit code ${exited?.code ?? "none"}, signal ${exited?.signal ?? "none"}`}`);
      await wait(restoreBackoff(attempts));
    }
    fail(new Error("the restore was stopped"));
  };
  void run();
  return {
    boot,
    done,
    pending: () => pending,
    matching: (test) => [...pending.keys()].filter(test),
    want(paths) {
      const missing = new Set(paths.filter((path) => pending.has(path)));
      if (missing.size === 0) return Promise.resolve();
      return new Promise((resolve) => {
        wanted.set(resolve, missing);
        if (child?.stdin.writable) child.stdin.write(`${JSON.stringify({ want: [...missing] })}\n`);
      });
    },
    stop() {
      stopped = true;
      child?.kill("SIGTERM");
      return done.then(() => {}, () => {});
    },
  };
}

export function restoredFirst(archiver, restoring) {
  const needed = (needles) => (path) => needles.some((needle) => typeof needle === "string" && NEEDLE.test(needle) && path.includes(needle));
  return {
    ...archiver,
    async restore(needles, exactPaths = null) {
      await restoring.want(exactPaths ?? restoring.matching(needed(needles)));
      return archiver.restore(needles, exactPaths);
    },
    async restoreSessions(sessions) {
      const wanted = new Set(sessions);
      await restoring.want(restoring.matching((path) => wanted.has(sessionOf(path))));
      return archiver.restoreSessions(sessions);
    },
  };
}

async function servedPieces(store) {
  const server = createServer(async (request, response) => {
    try {
      const bytes = await store.get(request.url.slice(1));
      response.writeHead(200, { "content-length": bytes.length });
      response.end(bytes);
    } catch (error) {
      response.writeHead(503);
      response.end(String(error?.message ?? error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { pieces: { url: `http://127.0.0.1:${server.address().port}/` }, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

export async function restore(root, store, owner, { exclude, exactScope, engine, parallel, retryMs, scratch, log, wait } = {}) {
  const manifest = await store.manifest();
  if (!manifest) return { manifest: null, files: 0 };
  const served = store.pieces ? null : await servedPieces(store);
  try {
    return await startRestore({ root, manifest, pieces: store.pieces ?? served.pieces, owner, exclude, exactScope, engine, parallel, retryMs, scratch, log, wait }).done;
  } finally {
    await served?.close();
  }
}
