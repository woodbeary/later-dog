import { createHmac } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";

export function rootHistorySecrets(env) {
  if (!env.LATERDOG_HISTORY_URL) return {};
  const expected = new URL("/history",env.LATERDOG_STATE_URL).href;
  if (env.LATERDOG_HISTORY_URL !== expected || !env.LATERDOG_STATE_TOKEN) throw Error("History service does not match the home store");
  const token = purpose => createHmac("sha256",env.LATERDOG_STATE_TOKEN).update(purpose).digest("hex");
  return { LATERDOG_HISTORY_TOKEN: token("laterdog history v1"), LATERDOG_HISTORY_RESTORE_TOKEN: token("laterdog history restore v1") };
}

export async function bootHistory(env, request = fetch) {
  const url = env.LATERDOG_HISTORY_URL,
    token = env.LATERDOG_HISTORY_TOKEN;
  if (!url && !token) return { mode: "legacy", generation: null };
  if (!url || !token) throw Error("History configuration is incomplete");
  const res = await request(url + "/status", {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw Error("History status returned " + res.status);
  const value = await res.json();
  if (value.mode === "held") throw Error("Conversation history is held for maintenance");
  if (
    !["legacy", "remote", "dual"].includes(value.mode) ||
    (value.mode !== "legacy" && typeof value.generation !== "string")
  )
    throw Error("History status is invalid");
  return value;
}
export function historyExclusion(mode, path) {
  if (/^\.laterdog\/history-pending\.json\.[0-9]+\.[a-z0-9-]+\.tmp$/.test(path)) return true;
  if (mode !== "remote" && path === ".laterdog/history-pending.json") return true;
  return mode === "remote"
    ? /^\.laterdog\/messages\.db(?:-(?:wal|shm|journal))?$/.test(path)
    : /^\.laterdog\/history-control\.db(?:-(?:wal|shm|journal))?$/.test(path);
}
function validCompact(file, generation) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    for (const marker of ["history_control_generation", "history_receipt_generation"]) {
      if (database.prepare("SELECT generation FROM " + marker + " WHERE singleton=1").get()?.generation !== generation)
        throw Error("Conversation history control generation does not match");
    }
    for (const table of [
      "messages",
      "thread_state",
      "native_runs",
      "native_run_events",
      "native_run_items",
      "native_run_retention",
    ]) {
      if (database.prepare("SELECT 1 FROM " + table + " LIMIT 1").get())
        throw Error("The compact history control contains remote history");
    }
  } finally {
    database.close();
  }
}

function confinedFile(root, relativeName) {
  let cursor = root;
  for (const name of relativeName.split("/")) {
    cursor = join(cursor, name);
    if (!existsSync(cursor)) return null;
    if (lstatSync(cursor).isSymbolicLink()) throw Error("Unsafe compact history control recovery path");
  }
  if (realpathSync(cursor) !== join(realpathSync(root), relativeName) || !lstatSync(cursor).isFile())
    throw Error("The compact conversation history control must be a regular file");
  return cursor;
}

export function verifyHistoryControl(data, generation, manifest) {
  const root = resolve(data);
  const inManifest = (path) =>
    manifest.entries.some((entry) => entry.path === ".laterdog/" + path && entry.type === "file");
  const control = "history-control.db";
  const journalName = ".backups/restore-journal.json";
  const journalFile = inManifest(journalName) && confinedFile(root, journalName);
  const journal = journalFile ? JSON.parse(readFileSync(journalFile, "utf8")) : null;
  const paths = [control];
  if (journal?.phase === "applying") {
    const id = journal.id;
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
      throw Error("Invalid conversation history restore journal");
    if (!Array.isArray(journal.existing) || !journal.existing.includes(control))
      throw Error("The original conversation history control is missing from restore recovery");
    const safety = ".backups/safety-" + id + "/data/" + control;
    if (inManifest(safety)) paths.unshift(safety);
  }
  for (const path of paths) {
    if (!inManifest(path)) continue;
    const file = confinedFile(root, path);
    if (file) {
      validCompact(file, generation);
      return;
    }
  }
  throw Error("The compact conversation history control is missing from the saved home");
}
