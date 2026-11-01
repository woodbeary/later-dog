# Metrics

What later.dog measures about computer-use runs ([laterdog/computer-use-loop.md](laterdog/computer-use-loop.md)), how
each number is defined, and the SQL that computes it. The definitions were written before any run data existed and do
not change to suit a result; a change to one is a dated entry at the end of this page.

Every query runs as written against the supervisor's `workspace.sqlite`. `server/laterdog/computer-use-metrics.test.ts`
runs each SQL block on this page against fixture runs, so a query here that stops working fails the tests.

## Definitions

- **Run**: one task on one cloud computer, a row in `computer_use_runs`. A run belongs to the week it started.
- **Done**: the run's state is `done`. There are two sources and no others: `person` (the person said Done) and
  `page_check` (the live-page check fixed when the run started passed). Claude cannot mark a run done.
- **Failed**: the state is `failed`, with one cause: `not_done`, `stopped`, `timed_out`, `step_limit`, `refusal`,
  `error` or `interrupted`.
- **Abandoned**: still `awaiting_done` 7 days after it started. An abandoned run counts as failed.
- **Unknown submit**: a step whose guarded action (a click or Enter the guard judged to submit, pay, publish, cancel or
  delete, run only after the person approved it) failed on the desktop, or after which no confirmation was seen
  (`computer_use_steps.outcome = 'submission_unknown'`). The loop never runs it again. Only the page check or the person
  settles it. A run that ends with one unsettled waits in the state `submission_unknown`.
- **Settled**: done, failed, abandoned, or `submission_unknown`. A `submission_unknown` run counts as failed until the
  person says Done or Not done. Runs still going are left out until they settle.
- **Success rate**: done runs ÷ settled runs.
- **Take-over**: a row in `computer_use_handoffs`, with its cause (`sign-in`, `captcha`, `payment`, `other`, or `person`
  when the person took the screen unasked) and who asked: `model` (Claude called `request_takeover`), `person`, or
  `screen_check` (Claude acted on a frame the screen check read as a sign-in, code or CAPTCHA screen; `probability` is
  the check's own). A run with a take-over counts as done only if it then reached `done`.
- **Step**: one Messages API call and the actions it asked for. **Step time** is `model_ms + action_ms`: from sending the
  request to the last action finishing, leaving out time the screen was with the person.
- **Tokens**: the API's own `usage` counts, per step.

## Success rate by week

```sql
SELECT strftime('%Y-%W', started_at) AS week,
       COUNT(*) AS settled,
       SUM(state = 'done') AS done,
       ROUND(100.0 * SUM(state = 'done') / COUNT(*), 1) AS success_pct
FROM computer_use_runs
WHERE state IN ('done', 'failed', 'submission_unknown')
   OR (state = 'awaiting_done' AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days'))
GROUP BY week
ORDER BY week;
```

## How runs ended

```sql
SELECT state,
       COALESCE(done_source, failure, CASE WHEN state = 'submission_unknown' THEN 'submission_unknown'
         WHEN started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days') THEN 'abandoned' ELSE 'waiting' END) AS how,
       COUNT(*) AS runs
FROM computer_use_runs
WHERE state IN ('done', 'failed', 'awaiting_done', 'submission_unknown')
GROUP BY state, how
ORDER BY runs DESC;
```

## Take-overs

Share of settled runs with at least one take-over, and how many of those were then done:

```sql
SELECT COUNT(*) AS settled,
       SUM(EXISTS (SELECT 1 FROM computer_use_handoffs h WHERE h.run_id = r.id)) AS with_takeover,
       SUM(r.state = 'done' AND EXISTS (SELECT 1 FROM computer_use_handoffs h WHERE h.run_id = r.id)) AS with_takeover_done
FROM computer_use_runs r
WHERE r.state IN ('done', 'failed', 'submission_unknown')
   OR (r.state = 'awaiting_done' AND r.started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days'));
```

Causes, and who asked:

```sql
SELECT cause, asked_by, COUNT(*) AS takeovers
FROM computer_use_handoffs
GROUP BY cause, asked_by
ORDER BY takeovers DESC;
```

## Unknown submits

How many guarded actions ended with an unknown outcome, and how their runs were settled:

```sql
SELECT COUNT(*) AS unknown_submits,
       SUM(r.state = 'done') AS settled_done,
       SUM(r.state = 'failed') AS settled_failed,
       SUM(r.state = 'submission_unknown') AS still_unknown
FROM computer_use_steps s
JOIN computer_use_runs r ON r.id = s.run_id
WHERE s.outcome = 'submission_unknown';
```

## Step time

Median and 95th percentile step time, in milliseconds:

```sql
WITH ranked AS (
  SELECT model_ms + action_ms AS ms,
         ROW_NUMBER() OVER (ORDER BY model_ms + action_ms) AS n,
         COUNT(*) OVER () AS total
  FROM computer_use_steps
)
SELECT MIN(CASE WHEN n >= 0.5 * total THEN ms END) AS p50_ms,
       MIN(CASE WHEN n >= 0.95 * total THEN ms END) AS p95_ms
FROM ranked;
```

## Steps and tokens per run

```sql
SELECT r.id, r.state, COUNT(s.step) AS steps,
       SUM(s.input_tokens) AS input_tokens, SUM(s.output_tokens) AS output_tokens,
       SUM(s.cache_read_tokens) AS cache_read_tokens, SUM(s.cache_write_tokens) AS cache_write_tokens
FROM computer_use_runs r
LEFT JOIN computer_use_steps s ON s.run_id = r.id
GROUP BY r.id
ORDER BY r.started_at DESC;
```

## One model

While the model is pinned, this returns one row:

```sql
SELECT model, COUNT(*) AS runs FROM computer_use_runs GROUP BY model;
```

## Changes to these definitions

- 2026-10-31: first version.
- 2026-11-01: a take-over can also be asked by the screen check (`asked_by = screen_check`). Runs record whether they had
  screen checks (`computer_use_runs.screen_checks`), and steps the screen check's reading of the frame Claude chose from
  (`screen_state`, `screen_probability`), so runs with and without the check can be compared.
- 2026-11-01: an unknown submit (`outcome = 'submission_unknown'`) and the run state `submission_unknown`, which counts as
  settled and failed until the person or the page check settles it. The guard's take-overs have the cause `confirm` and
  `asked_by = guard`. The success, how-runs-ended and take-over queries now include `submission_unknown` runs.
