import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import {
  HISTORY_RECEIPT_PREFIX,
  receiptDigest,
} from "../../../../../shared/history-receipt.ts";
import { digest, tableExists } from "./sqlite.mjs";
import { writeOnce, saveJson } from "./artifact.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const limit = 512 * 1024 - 2048;
const marker = "history_receipt_generation";
const utf8 = (value) => Buffer.byteLength(value, "utf8");
function assert(value, message) {
  if (!value) throw Error(message);
}
export function receiptGeneration(db) {
  return tableExists(db, marker)
    ? (db
        .prepare(
          "SELECT generation FROM history_receipt_generation WHERE singleton=1",
        )
        .get()?.generation ?? false)
    : null;
}

function* results(db) {
  if (!tableExists(db, "command_receipts")) return;
  const query = db.prepare(
    "SELECT CAST(rowid AS TEXT) id,typeof(result) storage,CAST(result AS BLOB) bytes FROM command_receipts ORDER BY rowid",
  );
  for (const row of query.iterate()) {
    assert(
      row.storage === "text",
      "A command receipt is not stored as UTF-8 text",
    );
    yield { id: row.id, value: decoder.decode(row.bytes) };
  }
}

export function captureReceipts(db, directory) {
  assert(receiptGeneration(db) === null, "Expected original receipt values");
  const seen = new Set(),
    blocks = [];
  let items = [],
    encoded = 0,
    bytes = 0,
    count = 0,
    logicalBytes = 0;
  const flush = () => {
    if (!items.length) return;
    const raw = Buffer.from(JSON.stringify(items)),
      id = digest(raw);
    writeOnce(join(directory, "receipts", id), gzipSync(raw, { level: 1 }));
    blocks.push(id);
    items = [];
    encoded = 0;
  };
  for (const { value } of results(db)) {
    const sha256 = digest(value);
    count++;
    logicalBytes += utf8(value);
    if (seen.has(sha256)) continue;
    seen.add(sha256);
    bytes += utf8(value);
    const item = { sha256, value },
      cost = utf8(JSON.stringify(item)) + 1;
    if (items.length && (items.length === 64 || encoded + cost > limit))
      flush();
    items.push(item);
    encoded += cost;
  }
  flush();
  return { v: 1, count, distinct: seen.size, bytes, logicalBytes, blocks };
}

function readBlock(directory, hash) {
  assert(/^[a-f0-9]{64}$/.test(hash), "Invalid receipt block hash");
  const raw = gunzipSync(readFileSync(join(directory, "receipts", hash)));
  assert(digest(raw) === hash, "Historical receipt block checksum differs");
  const items = JSON.parse(raw);
  assert(
    Array.isArray(items) &&
      items.length > 0 &&
      items.length <= 64 &&
      items.every(
        (i) => typeof i.value === "string" && digest(i.value) === i.sha256,
      ),
    "Invalid receipt bytes",
  );
  return items;
}

export function compactReceipts(db, directory, catalog, generation) {
  assert(receiptGeneration(db) === null, "Already marked command receipts");
  const expected = new Set(),
    used = new Set();
  let bytes = 0,
    count = 0;
  for (const block of catalog.blocks)
    for (const item of readBlock(directory, block)) {
      assert(!expected.has(item.sha256), "Duplicate verified receipt");
      expected.add(item.sha256);
      bytes += utf8(item.value);
    }
  if (tableExists(db, "command_receipts")) {
    const update = db.prepare(
      "UPDATE command_receipts SET result=? WHERE rowid=?",
    );
    for (const { id, value } of results(db)) {
      const sha = digest(value);
      assert(expected.has(sha), "Command receipt changed since archival");
      update.run(HISTORY_RECEIPT_PREFIX + sha, BigInt(id));
      used.add(sha);
      count++;
    }
  }
  assert(
    count === catalog.count &&
      bytes === catalog.bytes &&
      used.size === expected.size &&
      expected.size === catalog.distinct,
    "Receipt reference coverage differs",
  );
  db.exec(
    "CREATE TABLE history_receipt_generation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation TEXT NOT NULL)",
  );
  db.exec(
    "CREATE TABLE history_receipt_sizing(singleton INTEGER PRIMARY KEY CHECK(singleton=1),rows INTEGER NOT NULL,payload_bytes INTEGER NOT NULL)",
  );
  db.prepare("INSERT INTO history_receipt_sizing VALUES(1,?,?)").run(
    count,
    catalog.logicalBytes ?? catalog.bytes,
  );
  db.prepare("INSERT INTO history_receipt_generation VALUES(1,?)").run(
    generation,
  );
}

export async function getReceiptValues(api, hashes) {
  const response = await api.receiptBatch({
    op: "get",
    items: hashes.map((sha256) => ({ sha256 })),
  });
  assert(
    Array.isArray(response.items) && response.items.length === hashes.length,
    "Incomplete receipt readback",
  );
  const byId = new Map(response.items.map((item) => [item.sha256, item])),
    out = new Map();
  for (const sha of hashes) {
    const item = byId.get(sha);
    assert(item, "Missing required receipt");
    let value = item.value;
    if (value === undefined) {
      const binary = await new Response(
        await api.getReceipt(sha),
      ).arrayBuffer();
      value = decoder.decode(binary);
      assert(item.bytes === binary.byteLength, "Receipt length mismatch");
    }
    assert(
      typeof value === "string" && digest(value) === sha,
      "Receipt checksum mismatch",
    );
    out.set(sha, value);
  }
  return out;
}

export async function transferReceipts(
  api,
  directory,
  catalog,
  journal,
  identity,
  parallel = 8,
) {
  const witnessDir = join(
    journal,
    "receipts",
    digest(JSON.stringify(identity)),
  );
  let cursor = 0,
    problem;
  const run = async () => {
    while (!problem && cursor < catalog.blocks.length) {
      const block = catalog.blocks[cursor++];
      try {
        const witness = { ...identity, block },
          path = join(witnessDir, block);
        if (existsSync(path)) {
          assert(
            isDeepStrictEqual(JSON.parse(readFileSync(path)), witness),
            "Invalid receipt verification journal",
          );
          continue;
        }
        const items = readBlock(directory, block);
        if (items.length === 1 && utf8(JSON.stringify(items)) > limit) {
          const item = items[0],
            ack = await api.putReceipt(
              item.sha256,
              new Blob([item.value]).stream(),
            );
          assert(
            ack.sha256 === item.sha256 && ack.bytes === utf8(item.value),
            "Large receipt write not acknowledged",
          );
        } else {
          const ack = await api.receiptBatch({ op: "put", items });
          assert(
            Array.isArray(ack.items) && ack.items.length === items.length,
            "Receipt write incomplete",
          );
          const byId = new Map(ack.items.map((i) => [i.sha256, i.bytes]));
          assert(
            items.every((i) => byId.get(i.sha256) === utf8(i.value)),
            "Receipt write metadata differs",
          );
        }
        await getReceiptValues(
          api,
          items.map((i) => i.sha256),
        );
        saveJson(path, witness);
      } catch (error) {
        problem = error;
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, () => run()));
  if (problem) throw problem;
  return {
    distinct: catalog.distinct,
    bytes: catalog.bytes,
    blocks: catalog.blocks.length,
  };
}

export async function expandReceipts(db, generation, api) {
  assert(
    receiptGeneration(db) === generation,
    "Wrong command receipt namespace",
  );
  if (tableExists(db, "command_receipts")) {
    const update = db.prepare(
      "UPDATE command_receipts SET result=? WHERE rowid=?",
    );
    let group = [];
    const flush = async () => {
      if (!group.length) return;
      const keys = Array.from(new Set(group.map((r) => r.sha)));
      const resolved = await getReceiptValues(api, keys);
      for (const { id, sha } of group)
        update.run(resolved.get(sha), BigInt(id));
      group = [];
    };
    for (const { id, value } of results(db)) {
      group.push({ id, sha: receiptDigest(value) });
      if (group.length === 64) await flush();
    }
    await flush();
  }
  db.exec(
    "DROP TABLE IF EXISTS history_receipt_sizing; DROP TABLE history_receipt_generation",
  );
}

export function localReceiptAccess(directory, catalog) {
  const locations = new Map();
  for (const block of catalog.blocks)
    for (const item of readBlock(directory, block))
      locations.set(item.sha256, block);
  return {
    async receiptBatch({ op, items }) {
      assert(op === "get", "Local receipt source is read only");
      const byBlock = new Map(),
        result = [];
      for (const { sha256 } of items) {
        const block = locations.get(sha256);
        assert(block, "Unknown local receipt");
        if (!byBlock.has(block))
          byBlock.set(
            block,
            new Map(readBlock(directory, block).map((i) => [i.sha256, i])),
          );
        result.push(byBlock.get(block).get(sha256));
      }
      return { items: result };
    },
  };
}
