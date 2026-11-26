import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readCatalog, capture, verifiedRows } from "./package.mjs";
import { compact } from "./projection.mjs";
import { transferReceipts } from "./receipts.mjs";
import { digest } from "./sqlite.mjs";
import { mapLimit, fetchThread, importTable } from "./transfer.mjs";
import { saveJson } from "./artifact.mjs";
import { HISTORY_TABLES } from "../../../../../shared/history-migration.ts";

export async function stagePortableHistory(api, job, prepared, identity) {
  const { jobId, generation, expectedRevision } = identity;
  const pack = join(job, "history-import"),
    source = join(prepared, "messages.db");
  const snapshot = await capture(source, pack, { portable: true });
  const catalog = readCatalog(pack, snapshot.sha256);
  const approved = { ...identity, catalog: snapshot.sha256 };
  saveJson(join(pack, "approved.json"), approved);
  const stage = await api.admin({ op: "begin", expectedRevision });
  if (
    stage.jobId !== jobId ||
    stage.generation !== generation ||
    stage.previousRevision !== expectedRevision ||
    typeof stage.physicalGeneration !== "string" ||
    !["preparing", "fencing", "switched"].includes(stage.status)
  )
    throw Error("Foreign conversation restore generation");
  if (stage.status === "preparing") {
    await transferReceipts(
      api,
      pack,
      catalog.receipts,
      join(pack, "readback"),
      approved,
    );
    await mapLimit(catalog.shards, 4, async (shard) => {
      const { proof } = shard,
        threadId = proof.threadId;
      const witness = join(pack, "readback", "shards", digest(threadId)),
        loadId = digest(JSON.stringify([jobId, threadId, proof.sha256]));
      if (existsSync(witness)) {
        if (JSON.parse(readFileSync(witness)).sha256 !== proof.sha256)
          throw Error("Previously staged history changed");
        return;
      }
      const reset = await api.admin({
        op: "reset",
        threadId,
        loadId,
        expectedLoadId: null,
      });
      if (reset.loadId !== loadId)
        throw Error("Conversation restore load lease changed");
      let importError;
      try {
        for (const table of HISTORY_TABLES)
          await importTable(
            api,
            { threadId, loadId, table },
            verifiedRows(pack, threadId, table, shard),
          );
      } catch (error) {
        importError = error;
      }
      let sealed;
      try {
        sealed = await api.admin({ op: "seal", threadId, loadId, proof });
      } catch (error) {
        throw importError ?? error;
      }
      if (sealed.sha256 !== proof.sha256)
        throw Error("Incomplete restored conversation records");
      const independentlyRead = await fetchThread(api, threadId, null);
      if (independentlyRead.proof.sha256 !== proof.sha256)
        throw Error("Staged conversation receipt differs");
      saveJson(witness, { sha256: proof.sha256 });
    });
  }
  const output = join(prepared, "history-control.db");
  await compact(source, pack, snapshot.sha256, output, generation);
  rmSync(source);
  for (const legacy of catalog.legacy)
    rmSync(join(prepared, "messages-" + legacy.threadId + ".json"));
  const proofs = catalog.shards.map((s) => [s.proof.threadId, s.proof.sha256]);
  return { proofs, catalog: snapshot.sha256 };
}
