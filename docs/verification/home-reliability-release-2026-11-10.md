# Home reliability release, November 10

The runtime is published from main source `0ab6c979c266704bb5a1a051b370ef5f524e4c8d`, tree `7c69c583acbb74fcae3e089367cd807e67680253`. Production Worker `2728c797-8be9-40e6-afed-314f5552556f` deployed the reviewed image. The owner's actual container was observed running that image at application version 55, and all 80 dogs returned at 04:44:02.561 UTC on November 10.

## What changed

The existing R2 session archiver now discovers eligible untracked engine sessions and permits an oversized session to make progress within its soft sweep budget. The 72-hour age requirement stays. Complete thread, group and bot ownership is checked before archival; session IDs beyond any owner's 200-session restore bound stay local. Shared session gates and the existing serialized root archive/restore service hold conversation startup until saved context is available.

Database saves require space for the database, its WAL and a 256 MiB reserve before starting a temporary copy. When there is insufficient space or an upload fails, the prior complete database entry remains, ordinary files can advance, and the database is retried. Temporary copies are cleaned up. The release also includes the reviewed computer start-budget, requested-working-directory and canonical fresh-scratch guidance repairs.

Details: [untracked sessions](session-archive-untracked-2026-11-10.md), [database headroom](sync-snapshot-headroom-2026-11-10.md), [computer launch](heavy-command-start-2026-11-09.md), [fresh scratch](fresh-scratch-guidance-2026-11-09.md).

## Exact build and qualification

Image:

```text
registry.cloudflare.com/da1336ec3e3f7d9a4971022ae074c5d7/laterdog-home-reliability@sha256:a1bd8bad49721c1373adacadabcefdb4b836c7dd76728e3f5299ff47100cac91
```

Two separate Node 24 builds on Clover's computer produced identical 5,157,505-byte archives containing 712 files and 28 directories. Root independently checked every payload hash, ownership, mode, timestamp, runtime/config source and capability manifest. One compiled layer, with an opaque server directory, was appended to the exact prior image. Its 24 base layers and native configuration remain identical; the candidate has 25 layers. This is not a full Dockerfile rebuild. Dependencies, native CLI versions, Dockerfiles, Worker source and web assets did not change.

Independent Codex source review passed 27 focused archive checks in each of three runs, root/home type checks, lint, comment policy and brand policy. Its three documentation-policy failures were reproduced and repaired through complete source paths and 14 missing index links. Documentation, brand and comment policy checks subsequently passed. This does not relabel the previously recorded unrelated timing/environment failures as green. A final combined documentation/brand run passed eight assertions and hit the brand scan's 20-second timeout on the Mac. All three brand assertions passed when rerun separately with a 60-second test timeout.

A fresh isolated Cloud home, created after staging rollout completion, passed 61 native checks:

| Scope | Passed checks |
|---|---:|
| Actual image/server path, root archive, authentication, protected paths, exact restored bytes and ownership | 30 |
| Native SQLite WAL copy, constrained capacity, retained prior entry, retry and cleanup | 12 |
| Old untracked oversized session archive and later restoration | 13 |
| Two natural periodic R2 saves and restoration of the latest WAL row | 6 |

The first staging home was created during the old-image rollout window. Its unsuccessful SSH attempts are retained as failures; no native qualification is claimed from it. It was removed before the fresh fixture ran. No synthetic messages or data mutations were used on the owner's home.

## Production observations

All 14 bindings, including eight plain settings, matched their pre-deploy values. Production SSH configuration was unchanged. A fresh pre-deploy R2 manifest was 39.5 seconds old and contained the complete existing database entry.

The new container started at 04:32:19.968 UTC. Application readiness returned at 04:44:02.561 after the workspace restore. Startup 500/503 responses were retained as availability gaps, not missing records. The first post-readiness monitoring attempt had a connection failure. Only subsequent consecutive uncached successful samples qualify the stability window.

At 04:47:11 UTC, a newly downloaded R2 manifest was 31.5 seconds old, identified app source `0.3.46+0ab6c979c266`, and held a 72-chunk database entry with the new WAL stamp. An earlier read before the first new periodic save still showed the shutdown manifest and failed its freshness assertion; it is retained rather than counted as a successful fresh save.

The completed functional window is **2026-11-10T04:45:30.090Z–2026-11-10T04:55:38.968Z**: 21 consecutive qualified samples over more than ten minutes. All reads were uncached. All 80 dog IDs and all 155 baseline task IDs remained. The four WoW dogs stayed idle, and both saved model selections remained Codex / Sol / Medium.

| Operational reading | Before deployment | End of qualified window |
|---|---:|---:|
| Free disk bytes | 1,022,971,904 | 1,938,153,472 |
| Free disk, decimal GB | 1.023 | 1.938 |
| New runtime's session files archived | Not started | 178 |
| New runtime's session bytes archived | Not started | 288,873,804 |

**Storage capacity is not qualified:** all 21/21 samples retained the low-storage flag. The functional window passed; it does not establish larger-fleet capacity or eliminate that warning. Archiving is part of the normal runtime, but no future reclaim amount is promised.


Disk readings are operational observations, not a controlled performance benchmark. Restore exclusions, normal writes and temporary copies affect free space as well as archiving; the entire free-space change is not attributed to the archiver.

## Preserved state and limits

The monitoring checks retain all 80 dog IDs and every baseline task ID, all four paused WoW dogs, and Clover/Patch's saved Codex / GPT-6.1 Sol / Medium selections. Clover's actual release-build turn completed on that selection after the account reset; earlier fallback turns remain attributed to their reported engine.

Nextdoor remains at the user's intentional login wait. The resize experiment remains held; its stable published version was not replaced. The execution advisor remains an optional read-only tool, with no automatic model switch or claimed routing savings. See [execution advice](execution-advisor.md).

This release qualifies the stated functional window and staged native archive/backup contracts. It does not qualify 20 real concurrent provider workers, unlimited storage, every archived native-provider resume, or installation of new native binaries on physical devices. Monitoring ends with the recorded window. Existing broader test limitations remain in their individual verification records.

Both disposable homes were removed. The temporary staging SSH key, local key/host files and registry credentials were removed; the original shared test key, shared Worker/bucket and production credentials remain.
