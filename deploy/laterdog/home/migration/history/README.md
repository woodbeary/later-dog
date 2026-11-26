# Conversation history migration

Run these commands from a Node 24 checkout. Keep the configuration, output and journals under a private directory on the operator’s disk. The commands print checksums, sizes and counts. A successful hot import leaves the local message database authoritative in dual-read mode.

## Capture and hot import

Use `node deploy/laterdog/home/migration/history/home.mjs read home.json` to download a coherent saved manifest and only the database files and active legacy thread files it names. Set `stable` to the home’s stable namespace, `bindings` to a private Wrangler JSON config with the remote `STATE` bucket, `bucket` to the bound R2 bucket, `direction` to `forward`, and `directory` and `cache` to private local paths. Set `expected.sha256` and optionally `expected.etag` when selecting a particular checkpoint. The receipt records its exact manifest bytes, ETag and verified database file hashes.

Run `node deploy/laterdog/home/migration/history/main.mjs capture migration.json` with the recovered `data/messages.db` as `source` and a local `package` directory. The SQLite backup API also supports a source database with a live WAL. Keep all active legacy `messages-*.json` files next to it. Use the returned SHA-256 as `catalog`. Reuse the same content-addressed package directory between captures.

Configure `bindings` in the migration config with a remote `HISTORY_ADMIN` service binding to `laterdog-history` or `laterdog-history-test`, entrypoint `HistoryMigrationApi`. Set `stable`, `generation`, the original expected directory revision `expectedRevision`, and a private `journal` for this generation. The external authorities that advance application placement are separate.

1. Run `main.mjs status migration.json` and compare the generation, revision and mode with the selected release.
2. Run `main.mjs import migration.json`. It verifies immutable receipt payloads, loads every changed shard and streams a separate readback. A shard missing from the later source receives a verified empty replacement. Exact retries reuse receipts for the same immutable blob batch, shard load and checksum.
A legacy database reconstructed by a previous rollback can contain shard-allocated rowids. Set `preserveAllocatedRowids: true` when capturing that database. The receiving directory reserves a fresh range above the imported maxima when each shard is sealed.

3. Set `output` to a new local file and run `main.mjs compact migration.json`. Save the JSON receipt with the projected DB. This contains the original control rows, receipt references and the logical generation marker.

The three short command names above use the full path to `deploy/laterdog/home/migration/history/main.mjs`. All path fields are relative to the containing configuration file unless absolute.

## Frozen publication

Use the private home controller to collect a verified frozen original before publication. Repeat capture, import and compact for that exact source. Reuse the original generation and journal. Use the latest independent readback receipt to verify every shard against the frozen source.

Run `home.mjs stage home.json` with `sourceDirectory` from the read receipt, `database` pointing to the new SQLite output and `projection` pointing to its JSON receipt. The operation retains participating source chunks, stages both recoverable and normal target chunks and checks their readback. All other manifest entries retain their values. This writes immutable objects. The returned `target` is the SHA-256 of the planned manifest.

The private home controller commits the exact target while the source remains fenced. To publish it set `target`, `accountId`, `machineId`, `physicalId`, `boot` and `nonceFile` in the home config and provide its actual private `HOME_CONTROL` service binding. Run `home.mjs publish home.json`. It checks the tenant’s matching enrollment, typed home status, frozen source ETag and target digest. An ambiguous write can be retried against the same journal. Recheck the active shard directory, actual stored manifest and booted home before releasing the source hold.

## Reverse

Hold all active history writers and verify the directory barrier. Read the newest saved home with `direction` set to `reverse`. Use the recovered `data/history-control.db` as the new `source` and its exact file hash as `sourceSha256`. Configure the held directory `revision` and run `main.mjs export-frozen migration.json`. It verifies the directory and barrier at both ends of the read and preserves each shard's latest native event sequence.

Put the returned `catalog` in the config, select a new `output` and run `main.mjs reconstruct migration.json`. The tool expands the latest receipt payloads, writes every logical row with its original rowid, checks the reconstructed indexes, and compares all controls and shard contents before publishing a local file. Keep the current directory’s authenticated service binding for receipt resolution. Run `home.mjs stage` and `home.mjs publish` for the separately authorized reverse using the same guarded procedure. Retain all prior immutable generations through recovery.
