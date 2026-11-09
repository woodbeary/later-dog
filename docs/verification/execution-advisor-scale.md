# Execution advice under concurrent work

This recipe checks advice isolation, duplicate-safe sends, completion attribution
and the cost of aggregating synthetic history. It does not establish live model
quality, subscription charges, device thermals or production concurrency capacity.

## Ownership

Two implementations were considered for repeated history queries. A retained
history cache would own another copy of mutable ledger state and require correct
invalidation after append, replacement and restore. Grouping the existing query's
rows by account and model has no retained state or additional writer. The latter
is used in `server/laterdog/execution-advisor.ts`. Its complete reply remains the
same. The private HTTP route also returns that reply once; the existing tool caller
serializes it without an additional embedded JSON copy.

## Run

Use Node 24 and pnpm:

```sh
pnpm exec vitest run server/thread-capacity-api.test.ts server/execution-advisor.e2e.test.ts server/laterdog/execution-advisor.test.ts server/laterdog/execution-evidence.test.ts server/routes/execution-advice.test.ts server/routes/execution-receipts.test.ts server/usage-ledger.test.ts server/laterdog/supervisor.test.ts server/drivers/codex-helpers.test.ts server/drivers/claude-tasks.test.ts server/laterdog/helper-board.test.ts
pnpm exec node --expose-gc scripts/bench-execution-advice.ts --baseline-ref d2c39c4ede7308ee905b620e0473d2a65374a217
pnpm typecheck
pnpm lint
```

The benchmark reads the baseline implementation from Git and gives both variants
the current price table. It creates and removes a temporary import directory.
The output is `.laterdog-evidence/execution-advice-benchmark.json`. An explicit
`--output` path is supported. Both variants receive the same rows, candidates,
task, canonical per-thread titles and time. The script rewrites only the
baseline's task-title lookup, its matching scope and the one limitation sentence
describing that lookup to the canonical title input, asserts that the rewrite
happened exactly once and keeps the repeated-scan versus grouped algorithms. Each scenario checks complete reply equality, warms twice and
records five alternating pairs. The timer includes calculation and serialization
of a nonempty result. Disk reads, HTTP and provider work are outside that timer.
Input sizes are 50, 2,000 and 100,000 synthetic rows, each with 100 candidates.
Another 100 generated cases check complete output equality.

The concurrency fixture starts twenty real processes of the fake engine in
separate working directories. Every dog consults the actual private advice route
with its own active capability. Send retries leave one user message per dog.
After the fixture opens all finish gates, it waits for twenty distinct ledger
receipts. Provider completion stays unverified task completion. Existing scenarios
also exercise capacity overflow, queue cancellation and restored queues.

## Evidence and interpretation

The fixture retains its log and capacity receipt in the verification evidence
directory printed by the launcher. The tool fixture keeps its receipt and server
log in `.laterdog-evidence/execution-advisor/` after cleanup. Benchmark output
includes machine, load, raw timings, medians, ranges and response byte counts.

The timings below were recorded on 2026-11-08 under the earlier semantics, which
matched task text stored in each ledger row. They are not comparable with runs of
the canonical-title benchmark and are kept only as history.

On 2026-11-08 the focused eleven-file suite passed 72 checks. A separate phone
checkout's seven focused progress, account, stream, outbox and Stop files passed
78 checks; that does not qualify the installed phone build.

The recorded local benchmark host was an eight-core Apple M1 with 8 GB RAM,
Node 24.22.1 and active user workloads. Its reproducible run recorded median
calculation-plus-serialization times of 6.36 ms before and 3.16 ms after for
2,000 rows; 665.63 ms before and 214.95 ms after for 100,000 rows. The respective
ranges at 100,000 rows were 404.01–900.05 ms and 124.19–285.21 ms. At 50 rows the
ranges overlapped, so no meaningful improvement is claimed there. These are
local synthetic observations on a host that was not certified idle. They do not
establish a user-visible speedup or model cost savings.

A rerun on 2026-11-09 under the canonical-title semantics (8-core AMD EPYC cloud
checkout, Node 24.22.2, load average about 1.5, not certified idle) passed all 103
equal-reply checks and retained five alternating pairs per size. Median
calculation-plus-serialization times were 0.35 ms before and 0.30 ms after at 50
rows (ranges overlap in part: 0.31–0.41 and 0.23–0.32 ms, no improvement
claimed); 4.48 ms and 2.34 ms at 2,000 rows (4.08–5.06 and 2.25–2.74 ms); 408.24 ms
and 190.52 ms at 100,000 rows (354.57–629.21 and 145.25–206.47 ms). Raw samples
are in the benchmark output. These are synthetic, single-host numbers on different
hardware from the 2026-11-08 run and must not be compared with it.

Thirty-day ledger reads still synchronously read and parse month files before
advice aggregation. Grouping does not remove that event-loop blocking or bound
ledger bytes. The advisor still preserves the selected model: controlled,
independently verified task comparisons remain necessary before claiming a
better route. A provider success is not a task-quality label.
