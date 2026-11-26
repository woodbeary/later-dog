import { captureReceipts } from "./receipts.mjs";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import {
  HISTORY_TABLES,
  historyRowLine,
  historyThreadProofBytes,
} from "../../../../../shared/history-migration.ts";
import {
  checkpoint,
  controlProof,
  digest,
  eventSequence,
  fileHash,
  historyRows,
  threads,
  validateImportRow,
  verifySchema,
} from "./sqlite.mjs";

export const hex = /^[a-f0-9]{64}$/;
const CHUNK = 512 * 1024;
export { writeOnce, saveJson } from "./artifact.mjs";
import { writeOnce } from "./artifact.mjs";
export function verifiedRows(directory, thread, table, shard) {
  return verifiedLines(
    directory,
    shard.proof.tables[table],
    shard.chunks[table],
    (row, last) => validateImportRow(thread, table, row, last),
  );
}
export function* verifiedLines(directory, spec, chunks, validate) {
  const hash = createHash("sha256");
  let count = 0,
    bytes = 0,
    last = null;
  for (const block of chunks) {
    if (!hex.test(block)) throw Error("Invalid history chunk hash");
    const part = gunzipSync(readFileSync(join(directory, "rows", block)));
    if (digest(part) !== block || part.at(-1) !== 10)
      throw Error("Corrupt history chunk");
    hash.update(part);
    bytes += part.length;
    for (const line of part.toString("utf8").slice(0, -1).split("\n")) {
      const row = JSON.parse(line);
      validate(row, last);
      if (JSON.stringify(row) !== line) throw Error("Noncanonical history row");
      last = row[0];
      count++;
      yield row;
    }
  }
  if (
    spec.bytes !== bytes ||
    spec.count !== count ||
    spec.sha256 !== hash.digest("hex")
  )
    throw Error("History table proof mismatch");
}

export function tableCollector(directory, { importing = false } = {}) {
  const hash = createHash("sha256"),
    chunks = [];
  let count = 0,
    bytes = 0,
    parts = [],
    pending = 0;
  const flush = () => {
    if (!pending) return;
    const data = Buffer.concat(parts, pending);
    const id = digest(data);
    if (directory) {
      const path = join(directory, "rows", id);
      if (existsSync(path)) {
        if (!gunzipSync(readFileSync(path)).equals(data))
          throw Error("Conflicting history rows");
      } else writeOnce(path, gzipSync(data, { level: 1 }));
    }
    chunks.push(id);
    parts = [];
    pending = 0;
  };
  const push = (row) => {
    if (importing && BigInt(row[0]) >= 2n ** 40n)
      throw Error("Source rowid overlaps reserved shard allocations");
    const line = historyRowLine(row);
    if (pending && pending + line.length > CHUNK) flush();
    hash.update(line);
    bytes += line.length;
    count++;
    parts.push(line);
    pending += line.length;
  };
  const end = () => {
    flush();
    return { proof: { count, bytes, sha256: hash.digest("hex") }, chunks };
  };
  return { push, end };
}

export function collectTable(directory, rows, options) {
  const c = tableCollector(directory, options);
  for (const row of rows) c.push(row);
  return c.end();
}

export function collectThread(db, threadId, directory, options) {
  const tables = {},
    chunks = {};
  for (const t of HISTORY_TABLES) {
    const got = collectTable(directory, historyRows(db, threadId, t), options);
    tables[t] = got.proof;
    chunks[t] = got.chunks;
  }
  return {
    proof: {
      v: 1,
      threadId,
      tables,
      sha256: digest(historyThreadProofBytes(threadId, tables)),
    },
    chunks,
  };
}

export function readCatalog(directory, sha256) {
  if (!hex.test(sha256)) throw Error("Invalid history catalog hash");
  const raw = readFileSync(join(directory, "catalogs", sha256));
  if (digest(raw) !== sha256) throw Error("History catalog checksum mismatch");
  const value = JSON.parse(raw);
  if (
    value.v !== 1 ||
    !hex.test(value.sourceSha256) ||
    !Array.isArray(value.shards)
  )
    throw Error("Invalid history catalog");
  const ids = new Set();
  for (const shard of value.shards) {
    const { proof } = shard;
    if (
      ids.has(proof.threadId) ||
      digest(historyThreadProofBytes(proof.threadId, proof.tables)) !==
        proof.sha256
    )
      throw Error("Invalid history shard catalog");
    ids.add(proof.threadId);
  }
  return value;
}

export function importLegacy(db, directory) {
  const imported = [];
  for (const file of readdirSync(directory, { withFileTypes: true })
    .filter((f) => /^messages-(.+)\.json$/.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!file.isFile())
      throw Error("Legacy history source must be a regular file");
    const thread = file.name.slice(9, -5),
      path = join(directory, file.name),
      original = readFileSync(path);
    if (
      db.prepare("SELECT 1 FROM messages WHERE thread_id=? LIMIT 1").get(thread)
    ) {
      imported.push({
        threadId: thread,
        sha256: digest(original),
        source: "sqlite",
      });
      continue;
    }
    const value = JSON.parse(original);
    const records = Array.isArray(value) ? value : value?.messages;
    if (!Array.isArray(records)) throw Error("Invalid legacy thread file");
    const query = db.prepare(
      "INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(thread_id,id) DO UPDATE SET at=excluded.at,role=excluded.role,kind=excluded.kind,text=excluded.text,json=excluded.json",
    );
    for (const m of records)
      query.run(
        thread,
        m.id,
        m.at,
        m.role,
        m.kind,
        m.text ?? null,
        JSON.stringify(m),
      );
    db.prepare(
      "INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id",
    ).run(thread, Array.isArray(value) ? null : (value.activeLeafId ?? null));
    imported.push({
      threadId: thread,
      sha256: digest(original),
      source: "legacy",
    });
  }
  return imported;
}

export async function capture(
  source,
  directory,
  { legacyDirectory = dirname(source), portable = false } = {},
) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, randomUUID() + ".sqlite.part");
  try {
    await checkpoint(source, file);
    const sourceSha256 = await fileHash(file);
    const db = new DatabaseSync(file);
    try {
      verifySchema(db);
      const legacy = importLegacy(db, legacyDirectory);
      const shards = threads(db).map((thread) =>
        collectThread(db, thread, directory, { importing: !portable }),
      );
      const value = {
        v: 1,
        sourceSha256,
        legacy,
        eventSequence: eventSequence(db),
        controls: controlProof(db),
        receipts: captureReceipts(db, directory),
        shards,
      };
      if (
        !portable &&
        value.eventSequence !== null &&
        BigInt(value.eventSequence) >= 2n ** 40n
      )
        throw Error(
          "Source event sequence overlaps reserved shard allocations",
        );
      const data = Buffer.from(JSON.stringify(value)),
        sha256 = digest(data);
      writeOnce(join(directory, "catalogs", sha256), data);
      return {
        sha256,
        threads: shards.length,
        rows: shards.reduce(
          (n, s) =>
            n + Object.values(s.proof.tables).reduce((a, b) => a + b.count, 0),
          0,
        ),
      };
    } finally {
      db.close();
    }
  } finally {
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      rmSync(file + suffix, { force: true });
  }
}
