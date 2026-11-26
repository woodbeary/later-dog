# Holding a legacy home during working folder migration

Run `cutover-control.mjs` with Node 24 and the home Worker's dependencies installed by pnpm. It uses private Wrangler service bindings from the operator's Mac. The release controller must first drain the home's foreground turns and preserve its recorded detached jobs.

Create a private JSON config for each release.

```json
{
  "bindings": "bindings.json",
  "accountId": "test-folder-freeze",
  "machineId": "h0123456789abcdef01234567",
  "stable": "<64-character standard home R2 identity>",
  "physicalId": "<64-character current source Durable Object identity>",
  "leaseFile": "nonce.private",
  "journalDir": "window"
}
```

The Wrangler config must bind `CUTOVER` to the source home service's `WorkFolderMigrationApi` and `STATE` to its state bucket, both with `remote: true`. The private nonce file contains 32 random bytes encoded as 64 lowercase hexadecimal characters. The operator enrolls this single release by writing `{v:1,machineId,lease,image,expiresAt}` to `homes/<stable>/work-folders/cutover-enrollment`. Here `image` is the replacement image SHA-256, and `expiresAt` is a Unix millisecond timestamp within the next 24 hours.

1. Run `node cutover-control.mjs release.json status` and verify the source is open. Start `node cutover-control.mjs release.json hold` in its own Mac process. The operator journals the physical source, records a fresh immutable baseline in `window/snapshot.json`, and renews the hold using fresh connections while the separate migration process works.
2. Use the journaled baseline for the final source census, migration proof and restore-only candidate. Verify every claimed working folder and the coordinator on the separate physical disk. Preserve its terminal JSON at `work-folders/cutover-restore-results/<sha256>` and bind its SHA to the immutable candidate receipt. The enrolled migration bridge publishes the exact proposed placement through the source's private authority. The hold operator exits after it observes the commit.
3. To abort before publication, run `node cutover-control.mjs release.json abort`. After a lost operator, read `status` and the actual R2 placement. An expired source requires a fresh release nonce, journal and baseline before publication. A successful publication leaves the original disk sealed.
4. Deploy and verify the target home image using full Wrangler deployment and Cloudflare platform readback. Run `node cutover-control.mjs release.json retire` when the scheduler reports the configured image digest. When `status.configuredImage` is null, pass the SHA of the release operator's fresh platform readback as the final argument. The immutable record under `work-folders/cutover-image-selections/<sha256>` contains `v:1`, `stable`, `machineId`, `lease`, `image`, `placement`, `workerVersion`, `applicationId` and `observedAt`. The source checks it within two minutes of observation.
5. Check `status` for the retired revision, then read the user's original files through the replacement home. Retain the original snapshot, verification, physical restore result and release journal.
