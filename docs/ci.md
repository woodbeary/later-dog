# Hosted checks

Hosted checks are feedback only. The merge rule is still a complete local `pnpm gate` on a clean checkout (see `AGENTS.md`); a green hosted run does not replace it. Signing, notarizing, releases and device checks run from the owner's Mac, never on GitHub.

Everything runs on GitHub's free standard runner, `ubuntu-latest` (4 vCPU, 16 GB). A free account runs 20 jobs at once, so one pull request uses at most 18.

## Workflows

- `.github/workflows/pr.yml` runs on every pull request. Every job runs in parallel; the last job, `CI`, judges them.
- `.github/workflows/seed.yml` runs on a push to main and saves the install cache for the pull requests that follow.
- `.github/actions/prepare` is the shared setup: pnpm and Node from `packageManager` and `.nvmrc`, then the cache.

`scripts/laterdog-workflows.test.ts` pins exactly these files and what each must satisfy: only `ubuntu-latest`; `pull_request` (never `pull_request_target`) and a push to main for the seeder; read-only contents and a read-only Actions token restricted to the final timing inspector; no secrets; no `continue-on-error`; no retry wrapper; none of the gate's gap variables; actions pinned to a full commit hash; a blobless full-history checkout (`filter: blob:none`, never shallow).

## Jobs

| job                        | runs                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `scope`                    | `scripts/ci-scope.mjs`: is the change docs-only                                                          |
| `lint`                     | `pnpm lint`, then the brand, comment and verification-documentation tests                                |
| `typecheck`                | `pnpm typecheck`, checking both app and server projects with the pinned Bun binary                       |
| `build`                    | `vite build`, `pnpm build:server`, the packaged-server smoke                                             |
| `electron-broker`          | `pnpm test:electron`, `pnpm broker:test`                                                                 |
| `suite 1/8` to `suite 8/8` | the main suite, `vitest run --shard=n/8`                                                                 |
| `side <dir>`               | the tests in `deploy/laterdog/home`, `cloudflare/control-plane`, `deploy/laterdog/computers`             |
| `interface`                | the `ui.e2e` tests that drive a real browser (`LATERDOG_UI_E2E=1`)                                       |
| `CI`                       | fails if any job above failed, was cancelled, is missing, or was skipped without the docs-only selection |

## Type checking

`pnpm typecheck` uses the exact Bun version in the root devDependencies, installed
by `pnpm install --frozen-lockfile`. The workspace permits Bun's install script
to put the platform binary in `node_modules/bun/bin/bun.exe`; no global Bun
installation or package-manager change is needed.

`scripts/typecheck.mjs` checks both `tsconfig.json` and
`tsconfig.server.json` with `bun check --no-script --no-pretty`, even when the
first graph fails. It verifies the local binary's version, preserves diagnostics,
and requires a nonempty clean result for each graph. A missing binary, a signal,
an unsuccessful exit, printed errors or missing file counts fails the
command. The hosted typecheck job and the merge gate call this same command. The gate
requires separate successful file counts for both graphs.

[Bun's checker](https://bun.sh/docs/runtime/check) never emits JavaScript. TypeScript
stays installed for `build:server`, which emits the server JavaScript. The root
`build` runs the same `pnpm typecheck` before Vite builds the UI. The app config
uses explicit relative path targets because Bun's checker no longer accepts
`baseUrl`.

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

Eight shards, to match the shards of `pnpm gate` and keep a pull request at 18 of the 20 concurrent jobs. The weights are Windows medians (about 3,100 s in all). On `ubuntu-latest` the same files took about 6,900 s in the first hosted runs and the shards ran from about 470 s to about 1,260 s, so the weights need refreshing from Linux logs before the shards balance; until then a run takes about as long as its slowest shard, 20 minutes or more.

Refresh the times from a few recent green runs when shards drift apart:

```sh
node scripts/testing/update-shard-weights.mjs --run <run id> --run <run id> --run <run id>
```

Deleting or renaming a test file in the weights fails `scripts/testing/duration-sequencer.test.ts` until its entry is removed or refreshed. A refresh moves some files to other shards; a failure that appears only after one is a real ordering dependency between test files.

Measure a run with `node scripts/ci-audit.mjs <dir of job files>`.

## Time budgets

The final CI job checks every job in the exact current run attempt through the
[workflow-job API](https://docs.github.com/en/rest/actions/workflow-jobs), then
judges every needed job even if the timing inspection failed. Only that job
grants actions:read and passes its default read token to the inspector. It
never retries a request or job. A denied, incomplete, duplicated or malformed
response fails the check; unknown timing is never counted as zero. All pages
and all exact expected matrix members are required. Each test phase must name
its own shard or side app. Completed job and phase timestamps must be coherent
and contained inside their job. A first-work anchor is unique and complete,
except for the final job while the inspector itself is running. API records
must identify the requested run and attempt. Whole-second API timestamps limit
measurement precision; limits are not relaxed to compensate.

Waiting must be below ten seconds. Setup must be below thirty seconds, measured
as job-start to first-work-start wall time so composite action steps cannot be
counted twice. Lint and both-graph typecheck must each be below five seconds.
Each root shard, side-app suite, interface suite, Electron/Broker suite,
repository-contract suite and packaged-server smoke must be below sixty
seconds. The boundary itself fails. The report lists every violation.

The final job checks its own waiting and setup while it runs; its unfinished
verdict and post-job teardown have no separate phase budget. Build steps have
no invented duration limit. Runtime skips are accepted only for the existing
docs-only selection, and static jobs can never use that exception.

These are enforced targets, not an assertion that the current pipeline meets
them. Existing serial shards and cold setup exceed them. Their results remain
red until the underlying work is made faster; no limit, timeout, assertion,
retry policy or skip directive is relaxed. The unconditional hosted-contract
step runs scripts/ci-budgets.test.ts even for docs-only changes.
