# Session archive production release, 2026-11-09

Source: `0e0c163240ed3023f036a20f570badad966ce185`.

## Cause and shipped behavior

The log archiver left idle Claude provider sessions on the home volume. Capability 3 archives eligible sessions named by stored resume cursors after 72 hours and restores them before dispatch. Busy/shared sessions, credentials and unsafe paths remain protected. See [implementation and fixture evidence](session-archive-2026-11-09.md).

## Immutable image and qualification

Both canonical test and production container classes pin:

`registry.cloudflare.com/da1336ec3e3f7d9a4971022ae074c5d7/laterdog-session-archive@sha256:eae983668dde7c3a3e9c6f7380516a0dcc325acc491ee0bdb0652fbd1e577786`

Root assembled one complete 697-file server/runtime layer over the exact `42d5f089` production base. All 23 base layers remain; the candidate has 24 layers. No full Docker build or Colima restart occurred. Runtime configuration is deeply equal to the base; native binaries, web assets, provider/device/capacity limits remain unchanged. Matching runtime, Caddyfile, requirements, package metadata and build stamp ship together.

- Independent source audit `60af8971`: exact source passed 32 focused fixtures, including the isolated server restore-outage fixture; no blocking finding.
- Native matched-image qualification: 29 checks passed on a fresh synthetic test account. Checks covered capability 3, manifest/index/launcher hashes, root ownership and permissions, runtime syntax, Caddy/tini, scoped identity guard, bridge 401, credential-path refusal, whole-session protection, R2 archive of three synthetic files (196,743 bytes), byte-exact beforeTurn restoration, engine-owner readability and newer-local preservation.
- Bundled index SHA-256: `32f873c009cac3cdb6d0d39f92495c06c06718acc2d6e4838a9b515d3c109e74`.
- Launcher SHA-256: `acbb7f6642abffec2dfc78515af6c07dcd62664e3648e915b9ec82931362db08`.
- Preliminary fixture harness failures were corrected without runtime changes and retained separately from passing results.

Private qualification receipts remain on Jacob's Mac under `~/code/.wt/session-archive-rollout-20261109/.laterdog-evidence/session-archive/`. No credentials or private fixture material are included here.

## Deployment and activation

Patch performed a full test deploy with the approved ephemeral stage config: Worker `538e9b16-cdd1-4adb-8de2-b2597199b165`. After matched-image qualification, Root removed the fixture account and redeployed canonical test config as `d5655f04`, removing the disposable SSH key.

Production full deploy completed at 21:00:23 UTC; Worker `f2896fea-59d6-4fcc-9afe-142bc41ecf37` has 100% traffic since 21:00:13 UTC. Both image pins changed and the 14 bindings, including all eight plain variables and their values, compare byte-identical before/after. No second deploy was performed after the restart.

Root observed the actual large instance on application version 54 with the candidate image. Readiness returned at 21:13:55 UTC, PID 24, after the full R2 restore of 110,227 files / 14.15 GB caused about ten minutes of waking. Patch independently read `/app/cloud/build` and hashed the running index and launcher on the actual production home after restart, at 21:18:42 UTC: exact source, capability 3, both manifest hashes matching. The [retained production Bash receipt](session-archive-production-runtime-2026-11-09.json) supports this claim; Root qualified those files on stage and independently confirmed the actual production instance image and uncached APIs. Root observed all 80 dog IDs and baseline task identities retained, uncached health/storage/bots HTTP 200, Clover/Patch saved Codex Sol Medium selections preserved, and all four WoW dogs idle.

## Live storage evidence

Use authenticated uncached `/api/storage`: `archivedFiles`/`archivedBytes` are log-only here. Root `/status` generic totals can mix logs and sessions. Counters reset at server start.

Production checkpoint at 20:55:45 UTC: free disk 1,364,197,376 bytes; old log archive 5 files / 14,100,929 bytes; no session counters. At 21:14:16 UTC the new runtime reported free disk 1,669,025,792 bytes and zero session/log counters, with no completed scan. These cross-restart differences do not establish archive savings.

Completed scan observations (UTC, 2026-11-09), from retained `/tmp/patch-sa-storage-4.txt` and `/tmp/patch-sa-storage-9.txt` on the Mac:

| Reading | Scan started | Session files | Session bytes | Log files / bytes | Free disk bytes | Scan freeBefore / freeAfter |
| --- | --- | ---: | ---: | --- | ---: | --- |
| 21:16:06.293 | 21:14:52.678 | 42 | 134,129,685 | 0 / 0 | 1,165,496,320 | 1,665,208,320 / 1,797,103,616 |
| 21:25:56.604 | 21:23:53.577 | 66 | 307,225,188 | 0 / 0 | 1,302,384,640 | 1,239,519,232 / 1,867,223,040 |

Both scans had completed when read. Scan timestamps are 9 minutes 0.899 seconds apart. Session counters rose by 24 files / 173,095,503 bytes between readings. The first scan measured a 131,895,296-byte free-space increase. The later scan measured a 627,703,808-byte increase, but concurrent writes/cleanup mean that disk delta cannot be attributed solely to session archival. The 307,225,188 session bytes are the coordinator's cumulative archived-byte counter, not a claim of net capacity gained. Disk remained `low: true` at both reads.

Root's [public monitoring summary](session-archive-production-monitor-2026-11-09.json) records 21 consecutive qualified uncached samples from 21:13:55.880 to 21:24:04.290 UTC: same PID 24; all 80 dogs and baseline task identities retained; four WoW dogs idle; Clover/Patch saved selections preserved; no saved projections. All 21 samples reported low storage (free range 1,134,923,776–1,805,934,592 bytes). Functional readiness passed; capacity remains unqualified. The summary's final archive reading was mid-scan, so its stale `freeAfter` is not used for the completed-scan deltas above.

Root confirmed both test applications at version 67 retain only the original test SSH key and the candidate image; the fixture account and private fixture/registry credentials were removed. No additional production deploy was needed.

## Limits

A real archived native-provider thread answering with its old context remains unqualified unless legitimate work supplies a receipt. No synthetic messages were sent to real dogs. Codex/Grok stores and sessions without resume cursors remain outside scope; destructive archive GC remains disabled. Dev, WoW, supervisor and computers Worker were not restarted or redeployed by Patch. No provider, device or capacity limits were changed.
