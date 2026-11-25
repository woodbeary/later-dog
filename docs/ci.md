# Hosted checks

Hosted checks are feedback only. The merge rule is still a complete local `pnpm gate` on a clean checkout (see `AGENTS.md`); a green hosted run does not replace it. Signing, notarizing, releases and device checks run from the owner's Mac, never on GitHub.

Everything runs on GitHub's free standard runner, `ubuntu-latest` (4 vCPU, 16 GB). A free account runs 20 jobs at once, so one pull request uses at most 18.

## Workflows

- `.github/workflows/pr.yml` runs on every pull request. Every job runs in parallel; the last job, `CI`, judges them.
- `.github/workflows/seed.yml` runs on a push to main and saves the install cache for the pull requests that follow.
- `.github/actions/prepare` is the shared setup: pnpm and Node from `packageManager` and `.nvmrc`, then the cache.

`scripts/laterdog-workflows.test.ts` pins exactly these files and what each must satisfy: only `ubuntu-latest`; `pull_request` (never `pull_request_target`) and a push to main for the seeder; read-only contents; no secrets; no `continue-on-error`; no retry wrapper; none of the gate's gap variables; actions pinned to a full commit hash; a blobless full-history checkout (`filter: blob:none`, never shallow).

## Jobs

| job | runs |
| --- | --- |
| `scope` | `scripts/ci-scope.mjs`: is the change docs-only |
| `lint` | `pnpm lint`, then the brand, comment and verification-documentation tests |
| `typecheck` | `tsc -b --force` and the server project |
| `build` | `vite build`, `pnpm build:server`, the packaged-server smoke |
| `electron-broker` | `pnpm test:electron`, `pnpm broker:test` |
| `suite 1/8` to `suite 8/8` | the main suite, `vitest run --shard=n/8` |
| `side <dir>` | the tests in `deploy/laterdog/home`, `cloudflare/control-plane`, `deploy/laterdog/computers` |
| `interface` | the `ui.e2e` tests that drive a real browser (`LATERDOG_UI_E2E=1`) |
| `CI` | fails if any job above failed, was cancelled, is missing, or was skipped without the docs-only selection |

## Docs-only changes

Root Markdown files, Markdown under `docs/`, and `.github/FUNDING.yml` alone select the docs-only path. `lint`, `typecheck` and `scope` always run; `build`, `electron-broker`, `suite`, `side` and `interface` are skipped, and only then does `CI` accept their skip (`scripts/ci-verdict.mjs`). Any other change, an empty diff or an unreadable diff runs everything. Selection uses a local merge-base diff with rename detection off, so moving a source file into documentation still selects its runtime path.

## Install cache

The cache holds `node_modules` for the root, `cloudflare/control-plane` and the two standalone packages (`deploy/laterdog/home`, `deploy/laterdog/computers`), including the Electron binary the tests need. Its key is runner OS and architecture, `.nvmrc`, the `packageManager` field, and the hash of `pnpm-lock.yaml`, the two standalone lockfiles and `pnpm-workspace.yaml`. There is no fallback key: a hit means the lockfiles are identical.

- On a hit, `pnpm install --frozen-lockfile --offline` runs as a check, and a restore that disagrees with a lockfile fails the job.
- On a miss, the job installs everything, prepares Electron and saves. Pull requests save only on a miss; `seed.yml` does the same on main so pull requests find a cache from main.

## Concurrency

Pull request runs share a group named by the PR number (`checks-pr-<n>`) with cancel-in-progress, never `github.ref`: a merged PR's closed event reports the base branch as `github.ref`, which made every merge cancel main's checks (October 2026).

## Vitest shards

The suite runs one file at a time, so a shard takes as long as its files added up. Vitest's own `--shard` deals out equal numbers of files, and in October 2026 that put three of the four slowest e2e files in one shard. `scripts/testing/duration-sequencer.ts` deals the files out by recorded time instead, slowest first, each to the shard with the least time so far. The times are `scripts/testing/vitest-shard-weights.json`: each file's median seconds, for every file over five seconds and every e2e file. A file not in it counts one second, or the median e2e time if it is an e2e file. Every file still runs exactly once.

Eight shards, because the recorded times add up to about 3,100 s (the audit's Linux logs show 3,278 s as a lower bound): eight shards is about 400 s each, against 14 to 16 minutes for the four-shard setup in `docs/verification/hosted-checks-audit-2026-11-25.md`. The slowest file is 316 s, so no file holds a shard above the average, and eight matches the shards of `pnpm gate`. With `scope`, `lint`, `typecheck`, `build`, `electron-broker`, three side jobs, `interface` and `CI`, a pull request is 18 jobs of the 20 allowed; more shards would let two pull requests queue behind each other.

Refresh the times from a few recent green runs when shards drift apart:

```sh
node scripts/testing/update-shard-weights.mjs --run <run id> --run <run id> --run <run id>
```

Deleting or renaming a test file in the weights fails `scripts/testing/duration-sequencer.test.ts` until its entry is removed or refreshed. A refresh moves some files to other shards; a failure that appears only after one is a real ordering dependency between test files.

Measure a run with `node scripts/ci-audit.mjs <dir of job files>`.
