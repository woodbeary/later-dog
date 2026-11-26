import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { HISTORY_TABLES } from "../../../../../shared/history-migration.ts";
import { ensureNativeRuns } from "../../../../../server/laterdog/native-run-store.ts";
import {
  checkpoint,
  checkIndexes,
  clearHistory,
  controlProof,
  digest,
  eventSequence,
  fileHash,
  insertRow,
  setSequenceAtLeast,
  tableExists,
  threads,
  verifySchema,
} from "./sqlite.mjs";
import {
  collectThread,
  importLegacy,
  readCatalog,
  verifiedRows,
} from "./package.mjs";

const marker = "history_control_generation";
function verifyControls(db, expected) {
  if (!isDeepStrictEqual(controlProof(db), expected))
    throw Error("Coordinator control data differs");
}

async function project(source, target, fn, expectedSource) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = target + "." + randomUUID() + ".part";
  try {
    const checkSource = async () => {
      if (
        expectedSource &&
        ((statSync(source + "-wal", { throwIfNoEntry: false })?.size ?? 0) !==
          0 ||
          (await fileHash(source)) !== expectedSource)
      )
        throw Error(
          "Immutable control snapshot differs from its shard capture",
        );
    };
    await checkSource();
    await checkpoint(source, temp);
    await checkSource();
    chmodSync(temp, 0o600);
    const sourceSha256 = await fileHash(temp),
      db = new DatabaseSync(temp);
    let proof;
    try {
      db.exec("PRAGMA journal_mode=DELETE");
      verifySchema(db);
      proof = fn(db, sourceSha256);
      checkIndexes(db);
      if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
        throw Error("Projected SQLite integrity check failed");
    } finally {
      db.close();
    }
    const sha256 = await fileHash(temp);
    try {
      linkSync(temp, target);
    } catch (error) {
      if (error.code !== "EEXIST" || (await fileHash(target)) !== sha256)
        throw error;
    }
    return { ...proof, sourceSha256, sha256 };
  } finally {
    for (const suffix of ["", "-journal", "-shm", "-wal"])
      rmSync(temp + suffix, { force: true });
  }
}

export async function compact(
  source,
  directory,
  catalogSha256,
  target,
  generation,
  legacyDirectory = dirname(source),
) {
  if (typeof generation !== "string" || !generation)
    throw Error("Missing history generation");
  const catalog = readCatalog(directory, catalogSha256);
  return project(source, target, (db, sourceSha256) => {
    if (sourceSha256 !== catalog.sourceSha256)
      throw Error("Source SQLite changed since capture");
    if (tableExists(db, marker))
      throw Error("Source is already a history coordinator");
    if (!isDeepStrictEqual(importLegacy(db, legacyDirectory), catalog.legacy))
      throw Error("Legacy thread files changed since capture");
    verifyControls(db, catalog.controls);
    db.exec("BEGIN IMMEDIATE");
    clearHistory(db);
    ensureNativeRuns(db);
    db.exec(
      "CREATE TABLE history_control_generation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation TEXT NOT NULL)",
    );
    db.prepare(
      "INSERT INTO history_control_generation(singleton,generation) VALUES(1,?)",
    ).run(generation);
    db.exec("COMMIT; VACUUM");
    verifyControls(db, catalog.controls);
    if (threads(db).length || eventSequence(db) !== catalog.eventSequence)
      throw Error(
        "Coordinator compaction lost allocator state or retained history",
      );
    return { generation, catalog: catalogSha256, controls: catalog.controls };
  });
}

export async function reconstruct(
  source,
  directory,
  catalogSha256,
  target,
  generation,
) {
  const catalog = readCatalog(directory, catalogSha256);
  if (catalog.generation !== generation || catalog.fence === undefined)
    throw Error("Rollback requires a frozen shard capture");
  return project(
    source,
    target,
    (db) => {
      if (
        !tableExists(db, marker) ||
        db
          .prepare(
            "SELECT generation FROM history_control_generation WHERE singleton=1",
          )
          .get()?.generation !== generation
      )
        throw Error("Foreign coordinator generation");
      if (threads(db).length)
        throw Error("Coordinator contains unexpected local history");
      if (
        tableExists(db, "history_outbox") &&
        db.prepare("SELECT 1 FROM history_outbox LIMIT 1").get()
      )
        throw Error("Uncommitted history operations must drain before export");
      const controls = controlProof(db);
      db.exec("BEGIN IMMEDIATE");
      const insert = Object.fromEntries(
        HISTORY_TABLES.map((t) => [t, insertRow(db, t)]),
      );
      for (const shard of catalog.shards)
        for (const t of HISTORY_TABLES)
          for (const row of verifiedRows(
            directory,
            shard.proof.threadId,
            t,
            shard,
          ))
            insert[t](row);
      setSequenceAtLeast(db, catalog.eventSequence);
      db.exec(
        "DROP TABLE IF EXISTS history_outbox; DROP TABLE history_control_generation; COMMIT",
      );
      verifySchema(db);
      const expected = catalog.shards
        .filter((s) => HISTORY_TABLES.some((t) => s.proof.tables[t].count))
        .map((s) => s.proof.threadId);
      if (!isDeepStrictEqual(threads(db).sort(), expected.sort()))
        throw Error("Restored shard ownership differs");
      for (const shard of catalog.shards)
        if (
          collectThread(db, shard.proof.threadId, null).proof.sha256 !==
          shard.proof.sha256
        )
          throw Error("Restored history rows differ");
      verifyControls(db, controls);
      return {
        generation,
        catalog: catalogSha256,
        controls,
        threads: catalog.shards.length,
        eventSequence: eventSequence(db),
        fenceSha256: digest(JSON.stringify(catalog.fence)),
      };
    },
    catalog.sourceSha256,
  );
}
