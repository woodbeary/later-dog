---
name: benchmark-checklist
description: "Check any measured number before it is reported: label what kind of number it is, make the runs fair, clean and repeated, confirm the timer covered the real work, test the result against what limits it, and show it matters end to end."
---

# Benchmark checklist

Use before a speed, latency, throughput, cost, capacity or count goes into a PR, a doc, a job observation or a reply. A number goes out with its receipt: the commands, the raw runs and a verdict. {{TOOLS}}

## 1. Label it

- **Measured:** it passed everything below.
- **Ballpark:** one run, called a ballpark. It still needs clean output and a checked timer (steps 3 and 4).
- **Target:** a goal, such as a monthly PR count or a concurrency level. Never write it as an outcome.
- **Unknown:** there is no source. Say unknown instead of estimating, the way `record_job_observation` leaves a missing cost unknown.

## 2. Set up

Write the sentence you expect to report before you measure, and read the code that produces the number. Note the machine: model, cores, what else is running. Give every variant its real configuration (the same data and warm-up, each with its own best settings) so the old path is not left untuned to flatter the new one.

## 3. Run

Five or more runs per variant, alternating between variants. Keep every raw result. A run with an error, a retry, a timeout or a skipped step is a failed run: report it, never average it in.

## 4. Check

- **The timer.** The timed region holds the work you describe, and that work happened: output produced, rows written, request answered. An early return or an empty input makes anything fast.
- **The limit.** Name what stops the number from being much better (CPU, disk, network, a provider's rate limit, the supervisor's concurrency limit) and do the arithmetic. A result beyond what the hardware or a contract allows means the measurement is wrong.
- **The person.** Show the difference where someone using later.dog, or a cloud job, would notice it. A microbenchmark win alone is not a product claim.

## 5. Report

Median and range per variant, and a verdict: better, worse, no difference beyond the noise, or inconclusive. Put the commands, raw numbers and machine notes beside the claim: in the PR, on a page under `docs/verification/` (as `persistence-performance.md` does), or with `record_job_observation` for a cloud job. For cloud work, read outcomes from `laterdog_workspace` and keep PRs opened, verified and merged as three separate numbers.
