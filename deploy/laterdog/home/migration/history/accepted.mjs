import { receiptDigest } from "../../../../../shared/history-receipt.ts";
import { historyInteger } from "../../../../../shared/history-migration.ts";
import { tableCollector, verifiedLines } from "./package.mjs";

function validate(row, last) {
  if (
    !Array.isArray(row) ||
    row.length !== 6 ||
    !historyInteger(row[0]) ||
    !historyInteger(row[1]) ||
    !historyInteger(row[4]) ||
    typeof row[2] !== "string" ||
    typeof row[3] !== "string" ||
    typeof row[5] !== "string" ||
    (last !== null && BigInt(row[0]) <= BigInt(last))
  )
    throw Error("Invalid accepted history command");
  receiptDigest(row[5]);
}
export async function acceptedCommands(request, directory, head = undefined) {
  const collector = tableCollector(directory);
  let after = null;
  for (;;) {
    const page = await request({
      ...(after === null ? {} : { after }),
      limit: 128,
    });
    if (!Array.isArray(page.rows)) throw Error("Invalid accepted command page");
    for (const r of page.rows) {
      const row = [r.sequence, r.rowid, r.kind, r.key, r.at, r.resultRef];
      validate(row, after);
      collector.push(row);
      after = r.sequence;
    }
    if (page.next === null) break;
    if (!page.rows.length || page.next !== after)
      throw Error("Invalid accepted command cursor");
  }
  if (head !== undefined && head !== after)
    throw Error("Accepted commands changed during backup");
  return collector.end();
}

export function overlayCommands(db, directory, shards) {
  let added = 0,
    matched = 0;
  let byId, byKey, insert;
  for (const shard of shards) {
    if (!shard.commands) throw Error("The accepted command audit is missing");
    const { proof, chunks } = shard.commands;
    for (const row of verifiedLines(directory, proof, chunks, validate)) {
      if (!insert) {
        db.exec(
          "CREATE TABLE IF NOT EXISTS command_receipts(kind TEXT NOT NULL,key TEXT NOT NULL,at INTEGER NOT NULL,result TEXT NOT NULL,PRIMARY KEY(kind,key))",
        );
        const select =
          "SELECT CAST(rowid AS TEXT) id,kind,key,CAST(at AS TEXT) at,result FROM command_receipts WHERE ";
        byId = db.prepare(select + "rowid=?");
        byKey = db.prepare(select + "kind=? AND key=?");
        insert = db.prepare(
          "INSERT INTO command_receipts(rowid,kind,key,at,result) VALUES(?,?,?,?,?)",
        );
      }
      const [, id, kind, key, at, ref] = row;
      const existing = byId.get(BigInt(id)),
        keyed = byKey.get(kind, key);
      if (!existing && !keyed) {
        insert.run(BigInt(id), kind, key, BigInt(at), ref);
        added++;
        continue;
      }
      if (
        existing?.id !== id ||
        keyed?.id !== id ||
        existing.kind !== kind ||
        existing.key !== key ||
        existing.at !== at ||
        existing.result !== ref
      )
        throw Error(
          "Accepted command collides with a different local command receipt",
        );
      matched++;
    }
  }
  return { added, matched };
}
