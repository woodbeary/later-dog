# Saved repository environments, 2026-11-09

Merged to main as `fabdacbd2` and released on 2026-11-09: computers Worker version `88404e1d-8c6d-4f67-b5a7-f1caff06b3c4` (`wrangler deploy --containers-rollout=none`, image pin unchanged) and the server bundle built from `fabdacbd2`, running on the home since 12:44:36 UTC. See Live release below. The original branch notes follow. All
checks ran in Jacob's Mac worktree `~/code/.wt/kennel-envs2` with Node 24.22.1 (the home's `run_on_computer` copies
only folders on the home, and this worktree is on the Mac, so the Mac ran them).

## What changed

- `deploy/laterdog/computers/src/environments.ts`: keying (`env_` + hash of format, repository, setup-script hash and
  image), the rebuild and use rules, the default setup script, and the shell for registering the installed lockfile and
  for maintenance.
- `ComputerRegistry` (`registry.ts`): two new SQLite tables in the existing registry Durable Object,
  `environment_scripts` (a custom script per repository) and `environments` (per key: snapshot handle, built, restored,
  setup time, build in progress, last outcome). No new Durable Object class, binding, migration or wrangler change.
- `DogComputer` (`computer.ts`):
  - `buildEnvironment` runs the setup once on a fresh computer from the image, in its own Durable Object
    (`environment:<registry>:<key>`, not reachable through the API). The budget is 5 minutes; longer is reported
    `uncached` and nothing is saved. A good setup is snapshotted, reported to the registry, and the builder's container
    and storage are removed.
  - `init` and `wake` take `repository`. A computer with no snapshot of its own starts from the environment's snapshot
    (`containerSnapshot`), records which, and notes the restore so the 30-day clock restarts. A failed restore falls back
    to the image on the next wake.
  - After each start of such a computer, a maintenance step runs as `dog`: `git fetch`, fast-forward of a clean branch,
    and an install only when the lockfile hash differs from the installed one. Its outcome is in
    `computer.environment.maintenance`.
- Worker API: `POST /v1/environments` (set a custom script or `null`, build if due), `GET /v1/environments`,
  `repository` on create and wake. Free trial keys get 403 on the environments routes, and `repository` is ignored
  for their computers.
- Server: `ComputersClient.create`/`wake` pass `repository`, plus `prepareEnvironment` and `environments`.
  `run_on_computer` reads the GitHub `owner/name` of the folder's `origin` (credentials in the URL are dropped) and
  asks for the dog's computer with it (`heavyRunBox`).
- Reuse of the existing setup record, not a second one: the environment writes `~/runs/.setup/<lockfile hash>` and a
  `~/runs/<key>` link to its checkout, in the format `computer-runs.ts` already reads, so a session folder with the same
  lockfile copies the environment's `node_modules` instead of installing.

## Rules, as tested

| Case | Use the snapshot | Build |
| --- | --- | --- |
| No environment for this key (new repository, new script, new image) | no | yes |
| Build running for under 20 minutes | no | no |
| Built under 7 days ago | yes | no |
| Built 7 or more days ago, more than 3 days before expiry | yes | yes (while still used) |
| Within 3 days of 30 days after the build or the last restore | no | yes |
| Setup over 5 minutes (`uncached`) | no | only after 7 days |
| Failed build | the last good snapshot, if any | after 1 hour |

## Checks

| Check | Result |
| --- | --- |
| Computers Worker `vitest run` | 38 files: 37 passed, 1 skipped; 447 tests passed, 1 skipped (425 before; 22 new in `deploy/laterdog/computers/test/environments.test.ts`) |
| Computers Worker `wrangler types && tsc --noEmit` | exit 0 |
| `server/laterdog/cloud-computers.test.ts`, `server/laterdog/computer-runs.test.ts`, `server/laterdog/computer-run-route.test.ts`, `server/computers.test.ts` | 16, 10, 8 and 26 tests passed (5 new) |
| `scripts/brand-links.test.ts` | 3 passed, with the new files staged |
| `scripts/no-comments.test.ts` | 10 passed before the new files were staged. Rerun with them staged, its 180 s scan timed out on the loaded Mac (load average about 26), so the 17 changed files were checked directly with `remainingComments` and `node scripts/no-comments.ts --check`: no comments in code |
| `pnpm lint` | 0 warnings, 0 errors after rebasing onto main `075609e1a` (at `16d20b46b` it had 2 warnings in `electron/shared-computer-access.node-test.mjs`, which this branch does not touch) |
| `pnpm typecheck` | exit 0 |

The server tests run the real shell on a temporary home: the environment's lockfile key matches `setupKey()`, a session
copy with the same lockfile reuses the environment's packages, and maintenance against a local bare `origin` fetches,
fast-forwards, and runs the install only after the lockfile changed (a stub `pnpm` records the call).

## Time to ready, from the environment versus the image

Measured live after the release; see Live release below. The fixture estimate that came before it follows.

`deploy/laterdog/computers/test/environments.test.ts` → "time to ready for work on a repository" drives both paths through the Worker code with a
recorded fixture:

| Input | Value | Source |
| --- | --- | --- |
| Boot from the image to `running` | 6.6 s | measured live 2026-10-08 (README, Measured: create to `running`) |
| Boot from a snapshot to `running` | 5.7 s | measured live 2026-10-08 (README, Measured: wake from the snapshot, 5.6 to 5.8 s) |
| Setup (clone and first install) | 150 s | assumed |
| Maintenance with an unchanged lockfile | 4 s | assumed |

Result: 156.85 s to ready for work from the image (poll, boot, then the dog's own setup) against 9.95 s from the
environment (poll, boot, maintenance), and the computer that started from the environment ran no setup. The gap is
the setup time by construction. The real number depends on the repository. Measure it after a deploy: build an
environment for a real repository, create a computer with and without `repository`, and compare the `screen answering`
and `maintained ... in N ms` log lines with the builder's `setup` time.

## Live release (2026-11-09)

- Computers Worker `88404e1d-8c6d-4f67-b5a7-f1caff06b3c4`, deployed from `fabdacbd2` with the image pin unchanged. Before it: 447 Worker tests passed, 1 skipped, and `pnpm run check` exited 0.
- `GET /v1/environments` answered 200 and `POST` answered 202 with the home's computers key.
- Environment build: `POST /v1/environments {"repository":"woodbeary/later-dog"}` at 12:39:48 UTC. It finished `fresh`, `lastOutcome: ready`, `builtAt` 12:41:52 UTC, `setupMs` 92,619, key `env_9c66ba70a55b57e2ccb136717641756b`, `rebuildAt` 2026-11-16, `expiresAt` 2026-12-09. The private repository cloned without error. A later read-only `GET /v1/environments` returned the same record.
- Time to ready, one live observation of each path (a ballpark live check, not a repeated benchmark or a throughput figure): wall time from `POST /computers` to the first successful exec of `true`. Both were throwaway computers, deleted afterwards.
  - With `repository`: 2.46 s (POST answered in 1.08 s). It restored the environment snapshot: `~/repos/woodbeary/later-dog` at `fabdacbd`, 1.9 GB of `node_modules` present. Maintenance fetched and did not install, in 795 ms.
  - Without `repository`: 1.92 s (POST answered in 0.61 s), with no checkout. Getting the same checkout would have meant the 92.6 s setup.
- Not yet shown live: a dog's own computer starting from an environment during real work. Today only `run_on_computer` passes `repository`.

## Release needs

1. A full `wrangler deploy` of the computers Worker (`deploy/laterdog/computers`). The image does not change: the
   setup and maintenance scripts are sent by the Worker, and the image already has git, Node and npm. The deploy's
   image digest becomes part of every environment key, so the first use after any image rebuild builds new environments.
2. A desktop or Cloud home release for the server half (`run_on_computer` passing `repository`). A server on this branch
   against the deployed Worker is harmless: the older Worker ignores `repository`.
3. Live checks before relying on it: a restore from a snapshot taken by another Durable Object (Cloudflare documents
   this; not run here), snapshot size and cost for a real repository, and whether Chromium needs anything after
   restoring a builder's filesystem.

## Not done

- Private repositories. The default build clones over anonymous HTTPS and maintenance fetches without credentials. A
  clone credential belongs in the Worker's egress handling, never in the snapshot.
- The R2 mount (next step). A shared package cache on R2, mounted with FUSE, would let environments of different
  repositories and the dogs' own computers share downloads. The open question is the credential: an R2 key inside the
  container is readable by every command a dog runs and would be captured by every snapshot. Options to decide between:
  a Worker-side proxy that signs R2 requests on egress (the container sees only a placeholder), or short-lived,
  bucket-prefix-scoped tokens minted per start and kept out of `/home/dog`. Neither is built.
- Listing or deleting environments in the app, and choosing a setup script from the app. The API exists; there is no
  UI.
- A scheduled refresh. Environments are rebuilt when next used, not on a timer, so an environment nobody uses for 30
  days expires and is built again on its next use.
