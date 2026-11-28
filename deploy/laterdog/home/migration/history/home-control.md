# Holding the original home during a history migration

Use the private service binding to the selected home Worker's named `HistoryHomeMigrationApi` entrypoint. Its method is `control(accountId, nonce, request)`. Keep the 32-byte random lowercase hexadecimal nonce in a private operator journal. The HTTP home exposes no migration control route.

Publish a tenant-specific enrollment to `homes/<stable>/history/home-cutover.json`. Compare the previous enrollment before replacing it. Pin the original machine ID, physical Durable Object ID, current directory placement, and expected final placement from the actual tenant. `lease` is the lowercase SHA-256 of the 64 ASCII characters of the nonce. `expiresAt` is epoch milliseconds.

```json
{
  "v": 1,
  "machineId": "<machine>",
  "physicalId": "<physical Durable Object>",
  "lease": "<sha256 of nonce>",
  "source": { "mode": "dual", "generation": "<generation>", "revision": 1 },
  "target": { "mode": "remote", "generation": "<generation>", "revision": 3 },
  "expiresAt": 0
}
```

1. Start the compatible image and signed server under the original placement. Confirm the ordinary application is healthy. Call `{op:"begin"}`. Admission closes before checking the server's activity and its root maintenance channel. A busy source or missing root control socket releases this initial admission check. A launcher that cannot confirm its own shutdown stays on the original disk for recovery.
2. Call `{op:"status"}` while the application drains. Use `{op:"renew"}` to renew and retry a failed save. The launcher requires the actual application to finish all shutdown jobs successfully. The root also drains its archive, checkpoints mounted folders, checks the remote outbox and saves the coordinator. Incomplete saves leave the original volume available for retry or abort. The response reaches `held` only when the raw R2 SHA matches this save, the old writer has been revoked, and the original container is cold.
3. Journal `manifest` (the original raw R2 SHA), `etag` (the quoted original R2 ETag), `boot` and `physicalId`. Build the verified destination coordinator manifest and call `{op:"commit", manifest:"<target raw SHA>"}`. The response must contain `phase:"committed"` and the expected `projected`, `source` and `target`. The home stays cold.
4. Use the directory migration and immutable package proofs to complete the shard barrier, conditionally replace the original R2 manifest, and finish the destination directory placement. Call `{op:"release"}` after both destinations have been read back. It requires the exact target mode, generation and revision, the pinned raw R2 SHA, and a retired original writer. Then open the normal application.
5. On interrupted publication, resume from the same nonce and journal. `status` returns the original proof after a Worker restart. An expired lease keeps the home closed. `{op:"abort"}` may reopen the original placement and exact original coordinator. Before first remote activation, the directory can explicitly abandon a staged generation and attest that it never served. Once the remote generation served, return through a complete reverse migration so messages accepted remotely are retained. A reverse enrollment uses the current remote generation/revision as its source and the expected legacy revision with a null generation as its target.

Control responses contain `phase`, `physicalId`, `source`, `target`, `expiresAt` and, when available, `boot`, `manifest`, `etag`, and `projected`. Preserve the final receipt from the same nonce. For a later migration, issue a new nonce and a fresh enrollment.
