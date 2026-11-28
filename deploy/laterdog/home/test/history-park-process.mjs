import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { serveArchive } from "../runtime/archive.mjs";
import { openHistoryPark, parkRequest, verifyDrainedHistory } from "../runtime/history-park.mjs";
import { restore, snapshot } from "../runtime/sync.mjs";

const root = await mkdtemp(join(tmpdir(), "dog-hold-"));
const data = join(root, "source");
const home = join(data, ".laterdog");
const socket = join(root, "control.sock");
const lease = "a".repeat(64);
const control = (action) => parkRequest(socket, "/" + action + "/" + lease, "POST");
const marker = "last committed message during SIGTERM";
let child;
let park;
let archive;
let rejectSave = true;
let resumes = 0;
try {
  await mkdir(home, { recursive: true });
  const source = new DatabaseSync(join(home, "messages.db"));
  source.exec("CREATE TABLE messages(body TEXT NOT NULL)");
  source.close();
  const childProgram = `
    const db = new (require("node:sqlite").DatabaseSync)(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL");
    process.on("SIGTERM", () => {
      db.prepare("INSERT INTO messages VALUES (?)").run(process.argv[2]);
      db.close();
      process.exit(0);
    });
    process.send("ready");
    setInterval(()=>{}, 10000);
  `;
  child = spawn(process.execPath, ["-e", childProgram, join(home, "messages.db"), marker], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  assert.equal((await once(child, "message"))[0], "ready");
  const objects = join(root, "objects");
  await mkdir(objects);
  const store = {
    async has(hash) {
      try {
        return (await stat(join(objects, hash))).isFile();
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    },
    put: (hash, bytes) => writeFile(join(objects, hash), bytes),
    get: (hash) => readFile(join(objects, hash)),
    putManifest: (manifest) => writeFile(join(objects, "manifest.json"), JSON.stringify(manifest)),
    manifest: async () => JSON.parse(await readFile(join(objects, "manifest.json"), "utf8")),
  };
  park = await openHistoryPark({
    socketPath: socket,
    mode: "dual",
    generation: "release",
    canPark: () => true,
    stopChild: async () => {
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      assert.deepEqual(await exited, [0, null]);
    },
    save: async () => {
      const result = await snapshot(data, store, null, { scratch: join(root, "scratch") });
      if (rejectSave) {
        rejectSave = false;
        return { ...result, deferred: 1 };
      }
      return result;
    },
    resume: () => {
      resumes++;
    },
  });
  assert.equal((await stat(socket)).mode & 0o777, 0o600);
  const original = await control("status");
  assert.equal((await control("park")).phase, "parking");
  async function waitForPhase(phase) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const status = await control("status");
      if (status.phase === phase) return status;
      await delay(20);
    }
    throw Error("Timed out waiting for " + phase);
  }
  const failed = await waitForPhase("failed");
  assert.equal(failed.manifest, undefined);
  assert.equal(failed.boot, original.boot);
  assert.equal(park.active(), true);
  assert.equal(child.exitCode, 0);
  await assert.rejects(parkRequest(socket, "/abort/" + "b".repeat(64), "POST"), /403/);
  assert.equal((await control("retry")).phase, "parking");
  const saved = await waitForPhase("saved");
  assert.equal(saved.boot, original.boot);
  const bytes = await readFile(join(objects, "manifest.json"));
  assert.equal(saved.manifest, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(saved.entries, JSON.parse(bytes).entries.length);
  const restored = join(root, "restored");
  await mkdir(restored);
  await restore(restored, store, null);
  const check = new DatabaseSync(join(restored, ".laterdog", "messages.db"), { readOnly: true });
  assert.equal(check.prepare("SELECT body FROM messages").get().body, marker);
  check.close();
  assert.equal((await control("abort")).phase, "serving");
  assert.equal(resumes, 1);
  const remoteControl = new DatabaseSync(join(home, "history-control.db"));
  remoteControl.exec("CREATE TABLE history_outbox(id PRIMARY KEY); INSERT INTO history_outbox VALUES (1)");
  assert.throws(() => verifyDrainedHistory(home, "remote"), /still need delivery/);
  remoteControl.exec("DELETE FROM history_outbox");
  verifyDrainedHistory(home, "remote");
  remoteControl.close();
  const admitted = Promise.withResolvers();
  const finish = Promise.withResolvers();
  archive = await serveArchive(
    {
      status: async () => {
        admitted.resolve();
        await finish.promise;
        return { ok: true };
      },
    },
    { token: lease },
  );
  const getStatus = () => fetch(archive.url + "/status", { headers: { authorization: "Bearer " + lease } });
  const started = getStatus();
  await admitted.promise;
  let drained = false;
  const paused = archive.pause().then(() => {
    drained = true;
  });
  assert.equal((await getStatus()).status, 503);
  assert.equal(drained, false);
  finish.resolve();
  assert.deepEqual(await (await started).json(), { ok: true });
  await paused;
  archive.resume();
  assert.equal((await getStatus()).status, 200);
  console.log(
    JSON.stringify({
      platform: process.platform,
      node: process.version,
      manifest: saved.manifest,
      entries: saved.entries,
      childExit: child.exitCode,
      restoredMessage: marker,
      pausedArchive: true,
      pendingOutboxRejected: true,
    }),
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all([park?.close(), archive?.close()]);
  await rm(root, { recursive: true, force: true });
}
