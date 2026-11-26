# Migrate a home's working folders

Run the operator from a private external directory with Python 3.9+, Node 24+ and the checkout's pnpm dependencies. Use one journal per tenant and maintenance window. The operator never extracts an archive on the home. Its local working directory contains genuine user data. Keep that directory private and retain it through verification and rollback.

## Select the tenant

Create a local Wrangler configuration identifying the exact account and one remote R2 binding named `STATE`. Verify the bucket and the **stable state namespace** from the home record, including on large homes. From this package start the authenticated Mac bridge on a fixed loopback port using the checked-out modules.

```sh
node --experimental-transform-types migration/bridge.mjs "$R2_CONFIG" "$ACCOUNT_ID" "$BUCKET" "$STABLE_NAMESPACE" "$PORT" "$AUTHORITY"
```

The bridge exclusively creates the authority file with mode 0600 and reports its account/bucket/namespace fingerprint. It uses a fresh local authorization and the operator's R2 binding. The home bootstrap and previous-backup signing key stay private. Use a separate local authority file per running bridge.

## Verify and publish

Acquire the exact dated home manifest and the archived object index at its compatible save. Download only the selected working-folder chunks and the corresponding cold archive chunks into separate directories, naming each file with its raw SHA-256. `prepare` verifies every chunk and every recorded cold part including the whole archive's expected file and byte counts. Use the home’s attested project/loose allocation and any exact census delta for files omitted by the original save.

```sh
python3 migration/main.py prepare --package "$PACKAGE" --hot "$HOT" --manifest "$MANIFEST" --archive-index "$INDEX" --archive-blobs "$COLD" --projects "$PROJECTS" --supplement "$CENSUS"
python3 migration/main.py preload --package "$PACKAGE" --hot "$HOT" --authority-file "$AUTHORITY"
python3 migration/main.py retain-legacy --package "$PACKAGE" --hot "$HOT" --manifest "$MANIFEST" --authority-file "$AUTHORITY"
python3 migration/main.py publish --package "$PACKAGE" --hot "$HOT" --authority-file "$AUTHORITY" --journal "$JOURNAL"
```

Preload and retention can run while the legacy home continues working. Preload writes immutable objects. Publish also assigns folder heads. If an earlier snapshot was published, supply its exact JSON receipt through `--expected-heads` on the next publish. A newly prepared package can use `--reuse` with an earlier verified package directory for the same destination. The operator rejects divergent folder revisions.

Hold the live writer and every affected guest before activation. Capture a fresh final filesystem census, including new or deleted paths and hard links, and an exact current coordinator save. Repeat preparation, retention and publication from those final bytes as needed. Keep the source freeze until the new runtime has read back this tenant's committed placement.

```sh
python3 migration/main.py activate --package "$PACKAGE" --hot "$HOT" --authority-file "$AUTHORITY" --journal "$JOURNAL"
```

Activation requires agreement between the registry membership, all verified heads, the frozen raw coordinator manifest, and an independently retained closure of its original blobs. Each operation records immutable evidence in the journal. Rerunning an interrupted operation uses its existing intent. A changed source or overlapping writer produces a conflict requiring a fresh census. The operator checks final pointer bytes and releases its per-folder and registry fences.

## Restore a legacy reader

Freeze the active coordinator and guest writers. Retain the current coordinator state. Run rollback before returning a tenant to software that only understands the original layout.

```sh
python3 migration/main.py rollback --package "$PACKAGE" --hot "$HOT" --authority-file "$AUTHORITY" --journal "$JOURNAL"
```

Rollback projects the current immutable folder revisions, including newly created folders and explicit deletions, into the newest coordinator snapshot. It recovers missing historical checkpoint rows, restores a currently selected previous cloud backup and retains independently verified content at ordinary legacy object names. An independent Mac bridge can validate an app-sealed previous cloud backup through the tenant's private verification route. Original content, folder histories and both placement records remain available. Confirm the raw restored manifest checksum, latest guest edits, coordinator save and ordinary application reads before releasing the writer freeze.

To repair an individual retained legacy snapshot after older software collected its interchangeable primary blobs, first verify the required immutable manifest checksum, then run `repair-legacy` with that exact file. The command reconstructs only content-addressed legacy objects, leaving the active coordinator manifest and placement untouched. An unfinished, uncommitted window can release its own fences with `abort`; after the compatible legacy manifest has been installed, resume rollback to complete the placement change.
