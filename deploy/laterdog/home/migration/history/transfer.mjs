import { acceptedCommands } from "./accepted.mjs";
import { transferReceipts } from "./receipts.mjs";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  HISTORY_TABLES,
  historyThreadProofBytes,
} from "../../../../../shared/history-migration.ts";
import { digest, validateImportRow } from "./sqlite.mjs";
import {
  hex,
  readCatalog,
  saveJson,
  tableCollector,
  verifiedRows,
  writeOnce,
} from "./package.mjs";

const utf8 = (s) => Buffer.byteLength(s, "utf8");
function assert(value, message) {
  if (!value) throw Error(message);
}
const read = (path) => JSON.parse(readFileSync(path));
function rootProof(threadId, tables) {
  return {
    v: 1,
    threadId,
    tables,
    sha256: digest(historyThreadProofBytes(threadId, tables)),
  };
}
function emptyShard(threadId) {
  const tables = Object.fromEntries(
    HISTORY_TABLES.map((t) => [t, { count: 0, bytes: 0, sha256: digest("") }]),
  );
  return {
    proof: rootProof(threadId, tables),
    chunks: Object.fromEntries(HISTORY_TABLES.map((t) => [t, []])),
  };
}

export async function listThreads(api) {
  let after;
  const ids = new Set();
  for (;;) {
    const { threads, next } = await api.admin({
      op: "list",
      ...(after === undefined ? {} : { after }),
    });
    assert(Array.isArray(threads), "Invalid shard list");
    for (const id of threads) {
      assert(
        typeof id === "string" && id.length > 0 && !ids.has(id),
        "Invalid or repeated shard identity",
      );
      ids.add(id);
    }
    if (next === null) return [...ids];
    assert(
      typeof next === "string" && next !== after && next === threads.at(-1),
      "Invalid directory cursor",
    );
    after = next;
  }
}

export async function fetchThread(api, threadId, directory) {
  const tables = {},
    chunks = {};
  for (const table of HISTORY_TABLES) {
    const collect = tableCollector(directory);
    let after = null;
    for (;;) {
      const page = await api.page({
        op: "page",
        threadId,
        table,
        limit: 64,
        ...(after === null ? {} : { after }),
      });
      assert(Array.isArray(page.rows), "Invalid history page");
      for (const row of page.rows) {
        validateImportRow(threadId, table, row, after);
        collect.push(row);
        after = row[0];
      }
      if (page.next === null) break;
      assert(
        page.rows.length > 0 && page.next === after,
        "Invalid history page cursor",
      );
    }
    const result = collect.end();
    tables[table] = result.proof;
    chunks[table] = result.chunks;
  }
  return { proof: rootProof(threadId, tables), chunks };
}

export async function mapLimit(values, limit, fn) {
  assert(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= 32,
    "Invalid history parallelism",
  );
  let offset = 0;
  const results = new Array(values.length);
  let problem;
  await Promise.all(
    Array.from({ length: Math.min(values.length, limit) }, async () => {
      while (!problem && offset < values.length) {
        const i = offset++;
        try {
          results[i] = await fn(values[i]);
        } catch (error) {
          problem = error;
        }
      }
    }),
  );
  if (problem) throw problem;
  return results;
}

export async function importTable(api, base, rows) {
  let batch = [],
    bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    const result = await api.admin({ op: "import", ...base, rows: batch });
    assert(result.count === batch.length, "Unexpected imported row count");
    batch = [];
    bytes = 0;
  };
  for (const row of rows) {
    const serialized = JSON.stringify(row),
      size = utf8(serialized) + 1;
    if (batch.length && (size + bytes > 512 * 1024 || batch.length === 128))
      await flush();
    if (size > 512 * 1024) {
      const response = await api.importStream(
        base,
        new Blob([serialized + "\n"]).stream(),
      );
      assert(response.count === 1, "Large row import was not acknowledged");
    } else {
      batch.push(row);
      bytes += size;
    }
  }
  await flush();
}

export async function publishCatalog(
  api,
  directory,
  catalogSha256,
  journal,
  { stable, generation, expectedRevision, concurrency = 4 },
) {
  const source = readCatalog(directory, catalogSha256);
  const identity = { stable, generation, expectedRevision };
  saveJson(join(journal, "target.json"), identity);
  const started = await api.admin({
    op: "begin",
    expectedRevision,
    ...(source.eventSequence === null
      ? {}
      : { eventSequence: source.eventSequence }),
  });
  assert(started.generation === generation, "Unexpected migration generation");
  const receipts = await transferReceipts(
    api,
    directory,
    source.receipts,
    journal,
    identity,
  );
  const byId = new Map(source.shards.map((s) => [s.proof.threadId, s]));
  const remoteIds = await listThreads(api);
  for (const thread of remoteIds)
    if (!byId.has(thread)) byId.set(thread, emptyShard(thread));
  const results = await mapLimit(
    [...byId.values()],
    concurrency,
    async (shard) => {
      const { proof } = shard,
        threadId = proof.threadId;
      const path = join(journal, catalogSha256, digest(threadId));
      const status = await api.admin({ op: "shardStatus", threadId });
      let loadId = status.loadId;
      if (status.sha256 !== proof.sha256) {
        const proposed = {
          threadId,
          prior: status.loadId,
          loadId: randomUUID(),
          proof: proof.sha256,
        };
        if (!existsSync(path)) saveJson(path, proposed);
        const intent = read(path);
        assert(
          intent.threadId === threadId &&
            intent.proof === proof.sha256 &&
            (status.loadId === intent.prior || status.loadId === intent.loadId),
          "Foreign history import generation",
        );
        const reset = await api.admin({
          op: "reset",
          threadId,
          loadId: intent.loadId,
          expectedLoadId: intent.prior,
        });
        assert(reset.loadId === intent.loadId, "Unexpected replacement load");
        for (const table of HISTORY_TABLES)
          await importTable(
            api,
            { threadId, loadId: intent.loadId, table },
            verifiedRows(directory, threadId, table, shard),
          );
        loadId = intent.loadId;
      }
      assert(
        typeof loadId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(loadId),
        "Invalid remote load identity",
      );
      const attestation = join(
        journal,
        "readback",
        digest(threadId),
        loadId,
        proof.sha256,
      );
      const witness = { ...identity, threadId, loadId, sha256: proof.sha256 };
      if (status.sha256 === proof.sha256 && existsSync(attestation)) {
        assert(
          isDeepStrictEqual(read(attestation), witness),
          "Remote history witness differs",
        );
        return [threadId, proof.sha256];
      }
      const seal = await api.admin({ op: "seal", threadId, loadId, proof });
      assert(
        seal.sha256 === proof.sha256,
        "Remote seal differs from source rows",
      );
      const actual = await fetchThread(api, threadId, null);
      assert(
        actual.proof.sha256 === proof.sha256,
        "Independent row-by-row readback differs",
      );
      const after = await api.admin({ op: "shardStatus", threadId });
      assert(
        after.loadId === loadId && after.sha256 === proof.sha256,
        "History shard changed during readback",
      );
      saveJson(attestation, witness);
      return [threadId, proof.sha256];
    },
  );
  const actualIds = (await listThreads(api)).sort();
  assert(
    isDeepStrictEqual(actualIds, [...byId.keys()].sort()),
    "Shard directory changed during import",
  );
  const receipt = {
    v: 1,
    ...identity,
    catalog: catalogSha256,
    receipts,
    shards: results.sort((a, b) =>
      Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])),
    ),
  };
  saveJson(join(journal, catalogSha256, "verified.json"), receipt);
  return { threads: results.length, sha256: digest(JSON.stringify(receipt)) };
}

export async function exportFrozen(
  api,
  directory,
  {
    stable,
    generation,
    revision,
    sourceSha256,
    eventSequence = null,
    concurrency = 4,
  },
) {
  assert(hex.test(sourceSha256), "Invalid coordinator source checksum");
  async function fence() {
    const status = await api.admin({ op: "status" });
    assert(
      status.mode === "held" &&
        status.generation === generation &&
        status.revision === revision,
      "History directory is not on its expected writer fence",
    );
    const barrier = await api.admin({ op: "barrier", revision });
    assert(
      barrier.held === true && Number.isSafeInteger(barrier.threads),
      "History writer barrier incomplete",
    );
    return { v: 1, stable, generation, revision, threads: barrier.threads };
  }
  const before = await fence(),
    ids = (await listThreads(api)).sort((a, b) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    );
  assert(ids.length === before.threads, "Incomplete frozen shard directory");
  const shards = await mapLimit(ids, concurrency, async (threadId) => {
    const shard = await fetchThread(api, threadId, directory);
    shard.commands = await acceptedCommands(
      (q) => api.admin({ ...q, threadId, op: "commands" }),
      directory,
    );
    const value = (await api.admin({ op: "watermark", threadId }))
      .nativeEventSequence;
    assert(
      typeof value === "string" &&
        /^(0|[1-9][0-9]{0,18})$/.test(value) &&
        BigInt(value) <= 9223372036854775807n,
      "Invalid remote native event watermark",
    );
    if (BigInt(value) > BigInt(eventSequence ?? 0)) eventSequence = value;
    return shard;
  });
  const after = await fence();
  assert(
    isDeepStrictEqual(before, after) &&
      isDeepStrictEqual([...ids].sort(), (await listThreads(api)).sort()),
    "History writer fence changed during readback",
  );
  const value = {
    v: 1,
    generation,
    fence: after,
    sourceSha256,
    eventSequence,
    shards,
  };
  const raw = Buffer.from(JSON.stringify(value)),
    sha256 = digest(raw);
  writeOnce(join(directory, "catalogs", sha256), raw);
  return { sha256, threads: shards.length };
}
