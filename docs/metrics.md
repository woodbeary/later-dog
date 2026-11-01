# Metrics

What later.dog measures about computer-use runs ([laterdog/computer-use-loop.md](laterdog/computer-use-loop.md)), how
each number is defined, and the SQL that computes it. The definitions were written before any run data existed and do
not change to suit a result; a change to one is a dated entry at the end of this page.

Every query runs as written against the supervisor's `workspace.sqlite`. `server/laterdog/computer-use-metrics.test.ts`
runs each SQL block on this page against fixture runs, so a query here that stops working fails the tests.

## Definitions

- **Run**: one task on one cloud computer, a row in `computer_use_runs`. A run belongs to the week it started.
- **Done**: the run's state is `done`. There are three sources and no others: `person` (the person said Done),
  `page_check` (the live-page check fixed when the run started passed) and `state_check` (the desktop's own browser, read
  through its loopback DevTools port, showed the address and text fixed when the run started, in its active tab). Claude
  cannot mark a run done.
- **Failed**: the state is `failed`, with one cause: `not_done`, `stopped`, `timed_out`, `step_limit`, `refusal`,
  `error` or `interrupted`.
- **Abandoned**: still `awaiting_done` 7 days after it started. An abandoned run counts as failed.
- **Unknown submit**: a step whose guarded action (a click, or an Enter pressed or typed, that the guard judged to
  submit, pay, publish, cancel or delete, run only after the person approved it) failed on the desktop, or after which no
  confirmation was seen (`computer_use_steps.outcome = 'submission_unknown'`). The loop never runs it again. Only the
  page check, the state check or the person settles it. A run that ends with one unsettled waits in the state
  `submission_unknown`.
- **Settled**: done, failed, abandoned, or `submission_unknown`. A `submission_unknown` run counts as failed until the
  person says Done or Not done. Runs still going are left out until they settle.
- **Success rate**: done runs ÷ settled runs.
- **Take-over**: a row in `computer_use_handoffs`, with its cause (`sign-in`, `captcha`, `payment`, `other`, `person`
  when the person took the screen unasked, or `confirm` when the guard held an action) and who asked: `model` (Claude
  called `request_takeover`), `person`, `screen_check` (Claude acted on a frame the screen check read as a sign-in, code
  or CAPTCHA screen) or `guard` (an action looked like it would submit, pay, publish, cancel or delete, or could not be
  checked). `probability` is the check's own, when a check asked. A run with a take-over counts as done only if it then reached `done`.
- **Step**: one Messages API call and the actions it asked for. **Step time** is `model_ms + action_ms`: from sending the
  request to the last action finishing, leaving out time the screen was with the person.
- **Tokens**: the API's own `usage` counts, per step.
- **No visible effect**: an action (a click, drag, scroll, typing, key, or a typed Secure Form value) after which the next
  screenshot has the same SHA-256 as the frame before it (`computer_use_steps.screen_unchanged = 1`, kept on the step of
  the first such action since the last screenshot). A step with no screenshot after its action is left out.
- **Failure class**: what went wrong at a step, set by the person's review, never by the loop: `stale_screenshot`,
  `missed_click`, `wrong_field`, `page_not_settled`, `gave_up` or `environment`. Each step also keeps Claude's summarized
  thinking (`thinking`) to review it by.

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

## Failure classes

Steps by the failure class the review gave them:

```sql
SELECT failure_class, COUNT(*) AS steps
FROM computer_use_steps
WHERE failure_class IS NOT NULL
GROUP BY failure_class
ORDER BY steps DESC;
```

## Actions with no visible effect

```sql
SELECT COUNT(*) AS compared,
       SUM(screen_unchanged) AS unchanged,
       ROUND(100.0 * SUM(screen_unchanged) / COUNT(*), 1) AS unchanged_pct
FROM computer_use_steps
WHERE screen_unchanged IS NOT NULL;
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

## Cache reads

Share of each run's prompt tokens read from the prompt cache. Every screenshot stays in the conversation, so this is
what keeps a long run affordable; read it on the first live runs before turning on any context editing:

```sql
SELECT r.id,
       SUM(s.cache_read_tokens) AS cache_read_tokens,
       SUM(s.input_tokens + s.cache_read_tokens + s.cache_write_tokens) AS prompt_tokens,
       ROUND(100.0 * SUM(s.cache_read_tokens) / NULLIF(SUM(s.input_tokens + s.cache_read_tokens + s.cache_write_tokens), 0), 1) AS cache_read_pct
FROM computer_use_runs r
JOIN computer_use_steps s ON s.run_id = r.id
GROUP BY r.id
ORDER BY r.started_at DESC;
```

## Long take-overs

The prompt cache lasts five minutes by default. Take-overs that outlast it make the next step pay for the whole history
again, and are the reason to choose a one-hour cache instead:

```sql
SELECT COUNT(*) AS returned,
       SUM((julianday(returned_at) - julianday(at)) * 86400 > 300) AS over_5_min,
       CAST(ROUND(MAX((julianday(returned_at) - julianday(at)) * 86400)) AS INTEGER) AS longest_s
FROM computer_use_handoffs
WHERE returned_at IS NOT NULL;
```

## Events

`computer_use_events` is a view over the three tables that names what happened: `task_started`, `handoff`,
`handed_back`, `submission_unknown`, and `task_done` or `task_failed` with the done source or failure cause. It adds no
data of its own.

```sql
SELECT event, COUNT(*) AS events
FROM computer_use_events
GROUP BY event
ORDER BY event;
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
  `asked_by = guard`, and typed text with a line break in it counts as an Enter for the guard. The success,
  how-runs-ended and take-over queries now include `submission_unknown` runs.
- 2026-11-01: steps keep Claude's summarized thinking, a failure class the review sets, and whether the screen changed
  after an action (`thinking`, `failure_class`, `screen_unchanged`), with two queries for them.
- 2026-11-01: a third done source, `state_check`, for pages behind a sign-in that the page check cannot fetch. It is
  fixed at the start like the page check, and is tried after it.
- 2026-11-01: queries for cache reads and for take-overs longer than five minutes, and the `computer_use_events` view.
