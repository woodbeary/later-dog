# Hosted checks audit, 2026-11-25

The baseline for rebuilding later.dog's hosted checks. The repository has had no workflows since about 2026-11-08 to 11-14; this record measures how the last 150 runs of the main checks workflow ("later.dog CI", `.github/workflows/ci.yml`, described in [docs/ci.md](../ci.md)) spent their time. [scripts/ci-audit.mjs](../../scripts/ci-audit.mjs) produced every table below from saved job data and can be run again once hosted checks return.

## Method

- **Sample.** The 150 most recent runs of "later.dog CI" by run id: 41038651070 (created 2026-10-30T10:09Z) to 42467500790 (created 2026-11-08T09:30Z). The run list came from the public REST endpoint `GET /repos/woodbeary/later-dog/actions/runs` (1,031 runs in all: 639 of this workflow, 306 "macOS preview build", 86 cloud-home and dev-build runs).
- **Job data.** One `GET /actions/runs/{id}/jobs?per_page=100` per run, saved to disk unread, one file per run, plus the run list as `runs.json` (event, conclusion, created and start times). 143 runs returned 11 jobs each; 7 returned none. All 7 were pushes cancelled, so they count in the conclusion table and nowhere else. Where a run was re-run, the jobs are those of the latest attempt and wall time counts from the latest attempt's start.
- **Buckets.** *Waiting* is job `created_at` to `started_at`. *Setup* is the sum of the steps named Set up job, `actions/checkout`, `pnpm/action-setup`, `actions/setup-node`, any `pnpm install`, "Prepare ... runtime" and "Let Chrome use its sandbox". *Running* is every other step that is not a post step or Complete job, counted only for jobs in which at least one such step finished with success or failure, so jobs whose work was skipped do not pull the percentiles down. Post steps and Complete job are reported as *teardown* so the buckets add up. Step times have one-second resolution, so figures under about five seconds are rounded.
- **Percentiles.** Nearest rank. The sample size sits beside every percentile (`n` columns).
- **Per-test durations.** The logs of the vitest shard jobs and the renderer job for the 25 most recent fully successful runs (125 job logs, all downloaded from `GET /actions/jobs/{id}/logs`), parsed for the file lines Vitest prints with a duration.

## Headline

Linux is the only runner OS in this sample: every one of the 1,573 jobs ran on `ubuntu-24.04`.

| bucket | n jobs | p50 s | p95 s | share of summed job time |
| --- | --- | --- | --- | --- |
| waiting | 1503 | 3 | 6 | 1.0% (1.6 job-hours) |
| setup | 1573 | 18 | 26 | 4.1% (6.8 job-hours) |
| running (ran work) | 1539 | 169 | 965 | 94.8% (157.1 job-hours) |

Whole-run wall time (run start to last job completed): p50 998 s (16.6 min), p95 1711 s (28.5 min), n = 143 runs. Pull requests: p50 979 s, p95 1070 s, n = 52. Pushes to main: p50 1009 s, p95 1900 s, n = 91.

Conclusions of the 150: 84 success, 51 failure, 15 cancelled (pull requests 30 / 14 / 8, pushes 54 / 37 / 7).

## Where the time went

Running was 94.8% of all job time: 157.1 of 165.7 job-hours, against 6.8 for setup and 1.6 for waiting. Within running, the four vitest shards dominate: their running p50 is 825 to 933 s (n = 133 to 136 each), against 384 s for `verify`, 179 s for the renderer job and 5 to 35 s for the five small jobs. Because the jobs run in parallel, the run is as long as its slowest job: a shard's 933 s of running plus about 20 s of setup, 3 s of waiting and 1 s of teardown is 957 s, close to the 998 s run wall p50 (the difference is the run's own start and the spread across runs). Waiting was never the problem on this workflow: 3 s p50 and 6 s p95 across 1503 jobs, and setup is 18 s p50 for the jobs that install the full workspace (verify, renderer, shards, control-plane) and 4 to 8 s for the rest. The 70 jobs whose start time precedes their created time (re-runs keep the earlier created time) are left out of waiting only.

Shard balance: the four shard medians differ by 108 s (825 to 933 s), so the slowest shard sets the wall time. A few files carry it: in the logs below, the five slowest files sum to 951 s of the 3,278 s of summed per-file medians across 1,209 files that printed a duration (29%), the twelve slowest to 1,407 s (43%).

## Failures

Of the 143 runs with jobs, 34 jobs never ran a work step: 6 failed in a setup step (all in "Prepare Electron test runtime", 2 each in shards 1 and 2, 1 each in shards 3 and 4) and 28 were cancelled first. Their running time is excluded from the running percentiles and counted in the `no work step ran` column.

## Tables

### Runs

150 runs read, 143 with job data, 7 without.

| conclusion | runs |
| --- | --- |
| cancelled | 15 |
| failure | 51 |
| success | 84 |

| event | conclusion | runs |
| --- | --- | --- |
| pull_request | cancelled | 8 |
| pull_request | failure | 14 |
| pull_request | success | 30 |
| push | cancelled | 7 |
| push | failure | 37 |
| push | success | 54 |

### Run wall time (seconds, run start to last job completed; a re-run counts from its latest attempt)

| split | value | n runs | p50 s | p95 s | p50 min | p95 min |
| --- | --- | --- | --- | --- | --- | --- |
| event | pull_request | 52 | 979 | 1070 | 16.3 | 17.8 |
| event | push | 91 | 1009 | 1900 | 16.8 | 31.7 |
| runner OS | Linux | 143 | 998 | 1711 | 16.6 | 28.5 |
| all | all | 143 | 998 | 1711 | 16.6 | 28.5 |

### Buckets per job (seconds)

waiting: created to started; a job whose started time precedes its created time (a re-run keeps the earlier created time) is left out of that bucket. failed in setup: the job's own setup step failed. setup: set up, checkout, package manager, Node, install, runtime preparation. running: every other step, counted only for jobs that ran at least one work step. teardown (post steps, complete job) is listed for reconciliation.

| OS | job | n wait | waiting p50 / p95 | n setup | setup p50 / p95 | n ran work | running p50 / p95 | no work step ran | failed in setup | teardown p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Linux | cloudflare-worker | 136 | 3 / 11 | 143 | 8 / 14 | 143 | 5 / 6 | 0 | 0 | 1 / 1 |
| Linux | computers-worker | 136 | 3 / 6 | 143 | 8 / 16 | 143 | 16 / 17 | 0 | 0 | 1 / 1 |
| Linux | control-plane | 136 | 3 / 8 | 143 | 18 / 25 | 143 | 35 / 38 | 0 | 0 | 1 / 1 |
| Linux | home-worker | 137 | 3 / 11 | 143 | 8 / 13 | 143 | 10 / 11 | 0 | 0 | 0 / 1 |
| Linux | renderer tests (Ubuntu 24.04) | 136 | 3 / 7 | 143 | 18 / 25 | 143 | 179 / 198 | 0 | 0 | 1 / 1 |
| Linux | supervisor-container | 136 | 3 / 4 | 143 | 4 / 9 | 143 | 32 / 39 | 0 | 0 | 0 / 1 |
| Linux | verify | 136 | 3 / 8 | 143 | 19 / 27 | 143 | 384 / 423 | 0 | 0 | 1 / 1 |
| Linux | vitest (shard 1/4) | 139 | 3 / 10 | 143 | 20 / 28 | 133 | 880 / 971 | 10 | 2 | 1 / 1 |
| Linux | vitest (shard 2/4) | 136 | 3 / 6 | 143 | 20 / 28 | 134 | 825 / 914 | 9 | 2 | 1 / 1 |
| Linux | vitest (shard 3/4) | 139 | 3 / 8 | 143 | 20 / 28 | 136 | 933 / 1037 | 7 | 1 | 1 / 1 |
| Linux | vitest (shard 4/4) | 136 | 3 / 8 | 143 | 20 / 29 | 135 | 854 / 991 | 8 | 1 | 0 / 1 |

### Buckets across all jobs (seconds)

| OS | bucket | n jobs | p50 s | p95 s |
| --- | --- | --- | --- | --- |
| Linux | waiting | 1503 | 3 | 6 |
| Linux | setup | 1573 | 18 | 26 |
| Linux | running (ran work) | 1539 | 169 | 965 |

### First failed step per failed job

| job | step | jobs |
| --- | --- | --- |
| vitest (shard 4/4) | Run pnpm exec vitest run --shard=4/4 --reporter=default --reporter=github-actions | 31 |
| renderer tests (Ubuntu 24.04) | Drive the real renderer | 25 |
| vitest (shard 2/4) | Run pnpm exec vitest run --shard=2/4 --reporter=default --reporter=github-actions | 23 |
| vitest (shard 3/4) | Run pnpm exec vitest run --shard=3/4 --reporter=default --reporter=github-actions | 21 |
| vitest (shard 1/4) | Run pnpm exec vitest run --shard=1/4 --reporter=default --reporter=github-actions | 17 |
| verify | Run pnpm laterdog:test && pnpm exec vitest run src/lib/analytics.test.ts src/lib/laterdog-privacy.test.ts scripts/mascot-bodies src/components/Avatar.test.ts server/drivers/acp/grok-device-auth.test.ts | 11 |
| home-worker | Run pnpm test | 3 |
| vitest (shard 2/4) | Prepare Electron test runtime | 2 |
| vitest (shard 1/4) | Prepare Electron test runtime | 2 |
| verify | Run pnpm lint | 2 |
| vitest (shard 3/4) | Prepare Electron test runtime | 1 |
| vitest (shard 4/4) | Prepare Electron test runtime | 1 |

### Share of summed job time

| bucket | job-hours | share |
| --- | --- | --- |
| waiting | 1.6 | 1.0% |
| setup | 6.8 | 4.1% |
| running | 157.1 | 94.8% |
| teardown | 0.2 | 0.1% |


### Slowest test files (from 125 job logs)

Only files Vitest printed a duration for are counted (it prints one above its slow-test threshold). n is the number of logs a file's duration appeared in.

#### Linux

| file | n logs | p50 s | max s |
| --- | --- | --- | --- |
| server/delta-context.e2e.test.ts | 25 | 268.9 | 279.0 |
| server/room-coordination.e2e.test.ts | 25 | 212.8 | 219.6 |
| server/direct-coordination.e2e.test.ts | 25 | 173.7 | 206.3 |
| server/index.test.ts | 25 | 148.0 | 159.4 |
| server/account-battery.e2e.test.ts | 25 | 147.4 | 151.4 |
| server/drivers/claude.test.ts | 25 | 88.3 | 105.0 |
| scripts/testing/control-laterdog-ui.e2e.test.ts | 25 | 79.1 | 83.7 |
| server/routine-results.e2e.test.ts | 25 | 69.2 | 70.5 |
| server/cloud-lending-memory.e2e.test.ts | 25 | 60.0 | 70.1 |
| server/drivers/codex.test.ts | 25 | 59.4 | 62.0 |
| server/cloud-move.e2e.test.ts | 25 | 52.8 | 55.5 |
| server/automatic-recovery.e2e.test.ts | 25 | 47.7 | 49.5 |


## What could not be measured

- **Windows and macOS.** None of the 150 runs had a job on either; the runner-OS split has one row. The macOS preview build workflow (306 runs, a separate workflow) was not audited, so the macOS queueing that [docs/ci.md](../ci.md) describes is not measured here.
- **Waiting for 70 of 1,573 jobs.** Their start time precedes their created time, so no wait can be computed.
- **Per-test durations beyond 25 runs and Linux.** Logs were parsed for 25 runs only (the 25 most recent fully successful ones), for the shard and renderer jobs only, not for `verify` or the Worker jobs. Vitest prints a file's duration only above its slow-test threshold, so faster files are absent and the file medians are lower bounds on what a shard spent. Individual test times inside a file are in the logs but not tabled.
- **Cost.** Billed minutes and runner prices were not pulled; the figures are wall-clock job time.
- **Time between a push and the run being created.** The data starts at run creation.
- **Failed and cancelled runs are in the wall-time percentiles.** A cancelled run ends early, so these understate a complete run; a successful-only split was not made.

## Repeating it

```sh
mkdir runs && cd runs
curl -s "https://api.github.com/repos/woodbeary/later-dog/actions/runs?per_page=100" > list.json
# save each run's jobs as <run id>.json and the run objects as runs.json
node scripts/ci-audit.mjs runs [--logs <dir of <job id>.log files>]
```

The directory holds one `<run id>.json` per run in the shape GitHub returns for a run's jobs, and optionally `runs.json` with the run objects for event, conclusion and start time. The raw data is not committed.

## Contracts independent of runtime selection

The pull request lint job now runs `scripts/ci-scope.test.ts`, `scripts/ci-verdict.test.ts` and `scripts/laterdog-workflows.test.ts` alongside the existing repository rules. A workflow contract requires that job to have no condition or dependencies, and requires each contract command to have no step condition. The runtime selection and full merge gate policy are unchanged.

The new workflow contract failed on the unchanged workflow: 1 failed and 15 passed. With the wiring corrected and the selector unchanged, all 76 checks across the six unconditional files passed on the Mac with Node 24.22.1 and pnpm 9.15.3. The deliberate server assertion also failed when run directly.

Disposable [lab PR 273](https://github.com/woodbeary/later-dog/pull/273) is marked MUST NOT MERGE. Its first head, `7108fb0e2dee9ab308cec4c2e7096a63e7e36937`, changes the selector assignment to `runtime = false`, adds a valid TypeScript server test asserting `expect(true).toBe(false)`, and adds the new workflow contract. Its workflow is byte-for-byte the original #260 workflow. [Before run 45585449390](https://github.com/woodbeary/later-dog/actions/runs/45585449390), attempt 1, returned green: scope, lint, typecheck and CI passed while every runtime job was skipped. The actual event base was `903f379f88bf041b8fc78d52db086c1818bf2799`, tree `d3233a9b87a8957cddf5072f779bcc38a7dbc211`.

The second head, `944d623fe08ef8991f8010798b4eae21d40777c6`, changes only the unconditional workflow wiring. The selector regression, failing server test and new workflow contract are identical to the first head. [After run 45589034383](https://github.com/woodbeary/later-dog/actions/runs/45589034383), attempt 1, returned red: 18 selector contracts failed and 58 other checks passed, including all 16 workflow contracts. Lint and the final CI job failed; scope and typecheck passed. The runtime groups remained skipped under the deliberate selector regression. Both actual event bases match the first run exactly, and both checked-out merge trees match their respective lab heads.

The before and after runs took 125 and 102 seconds from creation to final update, one observation each. These are correctness observations, not a median, p95 or speed claim. Both used the existing standard public runners. The lab is closed, with its branch and both runs retained.

The before lab passed its ordinary no-comments, lint, typecheck and locale pre-push hook. The after push used an explicitly authorized `--no-verify` exception for its workflow-only delta, after verifying that all source and test blobs were unchanged, to avoid repeating identical source checks behind the Mac queue. Every hosted check remained enabled. The real fix retains its ordinary local checks. The deliberate selector regression and failing server test exist only on the lab branch. No merge or publication is qualified by these focused checks; the repaired base and a complete clean merge gate remain required.
