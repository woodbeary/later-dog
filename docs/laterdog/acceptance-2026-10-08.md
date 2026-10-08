# Live acceptance — first real cloud job (2026-10-08)

The first job later.dog ran for real, end to end, through the hosted supervisor on Cloudflare
(`https://laterdog-supervisor.<subdomain>.workers.dev`), against the project's own acceptance steps in
[verification.md](verification.md). Everything here was observed on the real services, not inferred from a returned
field: the Codex Cloud task, the GitHub branch and pull request, and the repository's own CI.

## Setup

| | |
| --- | --- |
| Repository | `woodbeary/task-com-ai`, base `main` at `f63d8ee` |
| Codex Cloud environment | `6a979a5b…` (generation not recorded: the CLI does not report it) |
| Supervisor | hosted, `publishingHost: remote`, Codex CLI 0.154.0 signed in with ChatGPT |
| GitHub | the supervisor's own `gh` device sign-in as `woodbeary`, authorized by the owner on 2026-10-08 |
| Behavioural check | `check` (task-com-ai's `Qualify TASK release` workflow: lint, typecheck, tests, Cloudflare build) |

## Step 1–2 — one narrow job, its diff, its task identity

- 07:50:25Z: job `edce81d2…` created through `POST /v1/jobs`: "Add a regression test for src/lib/map-geo.ts",
  write scope `scripts/` only.
- 07:50:28Z: the supervisor pinned a starting branch `laterdog/input/edce81d2…` at the base commit.
- 07:50:32Z: submitted to Codex Cloud as `task_e_6ac74b46…`; one early poll failed before the task was visible, and
  the supervisor kept the task identity instead of submitting twice.
- About 07:55Z: ready. The collected diff adds exactly one file, `scripts/test-map-geo.mjs` (48 lines), which tests
  every export of the module, including three the brief did not name.

## Step 3 — a draft PR from an actually remote supervisor

- The supervisor published from its own isolated checkout in the Cloudflare container:
  [woodbeary/task-com-ai#82](https://github.com/woodbeary/task-com-ai/pull/82), a draft, branch
  `laterdog/edce81d2…`, head `0e87cad6`, one file, authored through the supervisor's GitHub sign-in.
- Observed with `gh pr view` against GitHub itself.

## Step 4 — verification at the exact head, then an independent review

- task-com-ai's own CI ran on the PR: check `check` passed in 4m25s
  ([run 37746435766](https://github.com/woodbeary/task-com-ai/actions/runs/37746435766)).
- 08:00:04Z: the supervisor's `verify` recorded `passed` for head `0e87cad6`, with an evidence file stored in the
  container.
- The independent review was started as its own Codex Cloud job (`06c184b9…`), bound to the same head.

### A defect the fixtures could not show

- 08:00:13Z: the review job was created and submitted to Codex Cloud (`task_e_6ac74d91…`), then failed one second
  later with "Cloud status read failed (exit 1)". Re-attaching the same task (`reconcile`) failed the same way.
- Cause, observed with the local CLI: codex-cli 0.154.0 prints `[PENDING] …` for a task that is still running **and
  exits 1**; it exits 0 only once the task is ready. The adapter treated every non-zero exit as a failed read. The
  implementation job had survived only because it retries; a review job was failed on its first poll. The fixtures had
  assumed exit 0 for a pending task, which the 2026-10-06 audit had listed as unverified.
- Fix (edcf48850): the adapter reads the printed label whatever the exit code and fails a read only when nothing was
  printed or the command timed out; the supervisor fails a job only for an error while collecting. The new tests fail
  on the old code. Deployed to the hosted supervisor before the review was resumed.
- After the fixed supervisor was deployed and restarted, `repositories` and both jobs came back from the R2 backup
  within seconds. Re-attaching the review's existing task (`reconcile`, no resubmission) recorded the reviewer's verdict
  on the parent: **pass** for head `0e87cad6`. The reviewer read the module, the runner and the neighbouring tests,
  ran the new test and the whole offline suite (131/131), and noted that it could not open the PR page itself and
  worked from the brief and the exact commit.

## Step 5 — a correction becomes a new commit on the same PR

- A correction was sent to the published job through the supervisor's `correct` action (the same action a dog's
  `correct_cloud_job` tool calls; this run used the API directly, so no conversation was involved): add a short header
  comment to the test, change no assertion. The supervisor created repair job `a6d0868d…` aimed at the PR's own
  branch `laterdog/edce81d2…`.
- 08:11:00Z: the repair task was ready and its diff is exactly the two header lines, every assertion unchanged. Its
  starting point was the PR's own head `0e87cad6`. Between submission and completion the supervisor read the task's
  pending status without a single failed read, the first live proof that the fix above is deployed.
- Publishing the repair pushed to the same branch: GitHub shows
  [woodbeary/task-com-ai#82](https://github.com/woodbeary/task-com-ai/pull/82) at head `0ce6f443` with two commits,
  still one PR, still a draft. The old verification no longer applies to the new head, and CI re-ran on it.

## Step 6 — three jobs at once, a restart in the middle, no duplicates

- 08:12Z: three more jobs were submitted together: two in task-com-ai with separate write scopes (a regression test
  for `cancellation-fee-reconciliation.ts` under `scripts/`, and doc comments in `src/lib/map-geo.ts`), and one in
  txtclaw, whose `test` check has failed on `main` since 2026-08-15 (one end-to-end spec about free users and API
  keys): fix that failing check.
- All three were running in Codex Cloud within a minute, each with its own task.
- 08:13:56Z: `POST /admin/restart` while all three were running. The supervisor was back within seconds; all six jobs
  were restored, and each running job still held the same Codex task. Nothing was submitted twice.
- The desktop app played no part: every action went to the hosted supervisor, so "disconnect the desktop" holds by
  construction.
- All three finished, each diff inside its write scope: a 110-line test with the payment calls mocked
  ([task-com-ai#83](https://github.com/woodbeary/task-com-ai/pull/83)); three doc comments and no code change
  ([task-com-ai#84](https://github.com/woodbeary/task-com-ai/pull/84)); and for txtclaw, a product fix rather than a test
  edit, restoring an explicit 402 "Dev API subscription required" refusal for free users
  ([txtclaw#95](https://github.com/woodbeary/txtclaw/pull/95)).
- Publishing #84 first failed on a transient GitHub GraphQL error; the job stopped with that error as its blocker.
  Publishing again created the PR. GitHub lists exactly one PR per job branch: #82, #83, #84 and #95.
- With #83's job no longer running in the same scope, the supervisor verified #82's corrected head `0ce6f443`:
  **passed**. (While #83 was running, `verify` on #82 was refused as conflicting work in the same scope, which is the
  supervisor's rule.)
- CI on the new PRs: #83 and #84 passed their `check` and the supervisor verified both heads (**passed**).
  txtclaw #95 still failed its E2E step, now with 502 where the test expects 402, and the supervisor recorded
  **failed** for that head: the failing check was caught, not waved through.
- The cause sat next door: txtclaw's shared paid-access helper looks the user's plan up from its console backend
  first, and in CI that lookup fails with a 502 before the free-user branch can answer 402. A correction could only
  reuse the job's original paths, so no repair could reach the fix. Corrections may now name their own write scope
  (82b0e2fbc), deployed together with scoped dog tokens; a probe against the hosted supervisor showed a dog token reads
  the workspace, is refused for repositories and `/admin/*` with one plain sentence, and that the admin token cannot be
  sent under a dog's name (401).
- The txtclaw correction was sent with the CI evidence and the scope `tests`, `app/api/console`,
  `playwright.config.ts`: repair job `265b5aa6…` on the PR's own branch.
- The repair changed only `app/api/console/_shared.ts`: with no console backend configured, the plan lookup now
  treats the user as free instead of failing. CI still answered 502, so the supervisor recorded **failed** again. The
  E2E step itself configures the backend from the repository's `E2E_TXTCLAW_CONSOLE_*` secrets (set 2026-02-17; pull
  requests still passed in March), and that backend fails the plan lookup. That is stale infrastructure behind
  write-only secrets, not code a correction can reach. Owner action: point those two secrets at the live console Worker
  and its current token. Reviewer note on #95: the second commit is only safe if production sets
  `TXTCLAW_CONSOLE_BASE_URL` explicitly.

## Step 7 — what it cost and who had to step in

| | |
| --- | --- |
| Pull requests | 4 opened as drafts, 3 verified passing at their current head, 0 merged (merging stays with the owner) |
| Codex Cloud tasks | 8 (4 implementations, 1 review, 3 repairs), one attempt each, on the ChatGPT plan; the CLI reports no tokens or cost |
| Supervisor restarts | 4 (two deploys, one mid-run test, one metrics deploy); every job and task identity survived each one |
| Interventions | 2: re-attaching the review after the status-read defect; publishing #84 again after a GitHub GraphQL error |
| Defects found and fixed live | 4: the pending-status exit code (edcf48850), corrections confined to the original scope (82b0e2fbc), corrections reusing the parent's commit message (71d786130), metrics undercounting a corrected PR (9de639241) |
| Left for the owner | txtclaw's E2E secrets; reviewing and merging #82, #83, #84 (and #95 once its check passes) |

These are recorded as observations on the hosted supervisor as well. Concurrency stays at 4: this run used three
slots at once without contention, which is not yet evidence for more.
