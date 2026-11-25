# Linux shard timing collection, November 25, 2026

The weight updater now defaults to Linux jobs, accepting both `suite 1/8` and
historical `vitest (shard 1/4)` or `vitest (ubuntu-latest, shard 1/4)` names.
`--os windows` explicitly selects Windows matrix jobs. A run without matching
jobs, or a selected shard without file timings, fails before writing weights.
Job logs come from the Actions job-log API: `gh run view --log` returned an empty
successful response for these runs, while the API returned complete logs.

Existing weights survive when a sample has no positive duration for a file.
Measured light files and files that no longer exist still leave the weight table.
This prevents partial or skipped samples from silently replacing known durations
with the sequencer's one-second fallback.

## Source runs and coverage

The source is all eight Linux suite job logs from each run:

- [45549371601](https://github.com/woodbeary/later-dog/actions/runs/45549371601),
  commit `2edb252188dc48ece694dffd97892bec2485a7b4`.
- [45546603106](https://github.com/woodbeary/later-dog/actions/runs/45546603106),
  commit `9379f29a78e12769e7d3c9575cd3c1e1c3529709`.

Each log set yielded 1,483 file records. Of the 1,486 files in main `4efafe4ce`
plus the new updater test, 1,482 occur in both runs and 1,470 have a positive
duration in both. Twelve files are skipped in both; four have no record. One
source-only CI test is outside this file set and excluded from the model. Six of
the 133 existing weighted files have no positive measurement; the updater
preserves their old weights.

The four unobserved files are `scripts/desktop-perf-budget-file.test.ts`,
`scripts/desktop-perf-budget.test.ts`, `scripts/launch-timeline.test.ts`, and
`scripts/testing/update-shard-weights.test.ts`.

## Estimates, not a hosted speed result

A candidate table uses the median positive file duration across the two runs,
retaining existing weights for unmeasured files. It contains 218 weighted files.
The same 1,486-file set is passed to `planShards` with eight shards for both
the old 133-entry table and the candidate table. Each assignment is scored by
summing the same real per-file durations; no unmeasured time is invented.

| Shard | Old assignment, median measured seconds | Candidate assignment, median measured seconds |
| --- | ---: | ---: |
| 1 | 538.294 | 678.431 |
| 2 | 617.179 | 678.502 |
| 3 | 496.225 | 684.200 |
| 4 | 1,133.899 | 688.528 |
| 5 | 384.465 | 686.993 |
| 6 | 667.281 | 697.590 |
| 7 | 1,170.634 | 684.388 |
| 8 | 476.384 | 685.732 |

These are sums of Vitest file durations, fitted and evaluated on the same two
runs. They exclude queueing, runner setup, transform/collection overhead and
unmeasured files. They do not predict a new workflow's wall time or prove a
speed improvement.

The actual main-suite step times for shards 1 through 8 were:

| Run | Actual hosted seconds, shards 1 through 8 | Failed shards |
| --- | --- | --- |
| 45549371601 | 662, 614, 864, 996, 477, 463, 1139, 538 | 1, 7 |
| 45546603106 | 836, 795, 803, 999, 526, 473, 1255, 508 | 1, 7, 8 |

The checked-in weights remain unchanged. Both source runs failed, and failures
can distort durations. Refresh from complete passing Linux runs once those
failures are fixed, then compare actual hosted runs before claiming a speed gain.

## Use and checks

From the repository root, collect complete passing Linux runs with:

```sh
node scripts/testing/update-shard-weights.mjs --run <first-run-id> --run <second-run-id>
```

For Windows, add `--os windows`. Local Vitest logs and JSON reports remain valid
positional inputs; their platform is the caller's responsibility.

On the unchanged updater, the two weight-retention regression tests fail: the
60-second unobserved weight disappears, and the skipped 40-second weight becomes
one second. The original CLI also rejects run 45549371601 because it has no
Windows vitest jobs; the updated collector reads 1,483 files from that live run
using its Linux default. With the change, all 18 updater/sequencer tests pass, focused
oxlint reports no warnings or errors, and `pnpm typecheck` passes on Node 24.
The full merge gate remains required;
these focused checks do not qualify a merge.
