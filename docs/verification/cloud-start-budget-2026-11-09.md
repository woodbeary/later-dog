# Cloud computer start budget for dog turns

Branch: `kennel/cloud-start-budget-20261109`. Base: `2168474a291b8955b1c426337525f5d9eec2e0b3`.
First source commit: `4a718a4dd6941919529676e43e7136b824014406`. Join repair: `e0c42ddffb3d8449a73ad6b2d28021f0297f14a9`. Disconnected Settings repair: `1ff6a0e2ad2b4d0d17d6ec2f7a2921ed7df85702`, the source tested last below. Later commits change only this record.

## Cause

A dog turn that needs its sleeping cloud computer goes `attachBotBoat` -> `startBotBoat` ->
`wakeBotBoat` -> `readyBoat`. The turn had a 150 s outer budget, but the wake inside it called
`readyBoat` with its own 60 s default, so the turn gave up at about 60 s. The computers service
allows a boot `BOOT_TIMEOUT_MS = 5 * MINUTE` (`deploy/laterdog/computers/src/computer.ts`).
Two Patch turns on 2026-11-09 (23:21:16 and 23:42:57 UTC) ended after repeated
"still starting; call not performed" while the same computer finished a normal snapshot wake
at 23:45:17 UTC.

## Change

- `server/laterdog/cloud-start.ts` holds the facts: `CLOUD_COMPUTER_BOOT_MS` (5 min, matching the
  service) and a 30 s margin for the final read and network. The default turn start budget is
  their sum, 330 s. `LATERDOG_CLOUD_COMPUTER_START_BUDGET_MS` still overrides it, with the same
  1 s floor, so isolated tests keep short budgets.
- Only the turn caller changes: the wake inside `startBotBoat` gets what is left of the turn's
  budget. `wakeBotBoat` and its other caller (the wake route) keep the 60 s default.
  `run_on_computer`, provisioning (90 s) and joins are unchanged.
- The turn's wake stops as soon as no turn still wants it (Stop, or a newer turn generation),
  and never wakes the computer again after that. A newer turn that joins a pending wake keeps it
  alive. A computer that the turn saw starting and that then reports an error is not woken
  again; the turn ends with its existing "didn't start" row.
- The 45 s per-call pending answer is unchanged. No queue, watcher, UI or Worker change.

## Joined wakes

Clover's review of `830641cb` reproduced a gap: the Settings wake (`POST /api/bots/:id/computer/provision`
during an active turn) starts its own 60 s wake, and a turn that joined it died when that wait
ended, even though the computer was still starting. Repair, at the same caller:

- A turn that joins a wake it did not start, and gets nothing back, checks the computer once. Only
  if it is confirmed `starting` or `provisioning` does the turn keep waiting, for its own remaining
  budget, with its own Stop and newer-turn check, and without ever resuming, creating or retrying.
  Error, asleep, stopped, missing or unknown states end the turn as before.
- A Settings wake that joins a turn's wake keeps that wake alive only while its HTTP response is
  open (`!res.destroyed`), so a connected Settings request still reports ready if the turn is
  stopped. A Settings client that disconnects no longer keeps a stopped or replaced turn's wake
  polling (see Review findings).

## Evidence

On Kennel's own cloud computer, Node v24.22.2, pnpm 10.33.0.

- Before, on base `2168474` with only the new tests copied in:
  `vitest run server/laterdog/cloud-start.test.ts server/cloud-computer-slow-start.e2e.test.ts`
  gave 5 failed, 7 passed. A turn stopped during a wake woke the sleeping computer a second time
  (2 resumes, expected 1). A wake that takes 65 s ended the turn at the old 60 s wait
  (`the internal turn capability has expired`). The three new budget unit tests failed.
- After, at `4a718a4`: 11 files, 75 tests passed: `cloud-start`, `cloud-computer-slow-start.e2e`
  (6, including the 65 s wake that attaches with one resume and no create, and the stopped
  turn that never wakes the computer again), `boat-wait-ready`, `boat-turn`, `boat-lifecycle`,
  `boat-provision`, `computers`, `boat-included.e2e`, `place-view.e2e`, `surface-pins.e2e`,
  `scripts/no-comments`.
- `tsc --noEmit -p tsconfig.server.json`: exit 0. No comments in the six changed files.
- A unit test reads the service's `BOOT_TIMEOUT_MS` and `MINUTE` and fails if they drift
  from `CLOUD_COMPUTER_BOOT_MS`.

Join repair, at `e0c42dd`:

- Before, `830641c` with the new e2e file: 2 failed, 8 passed. A Settings wake that joined a turn's
  wake reported `ready: false` after the turn was stopped; a turn that joined a 60 s Settings wake
  for a 65 s boot ended with `the internal turn capability has expired`.
- After: 11 files, 80 tests passed (the same set as above; slow-start e2e now 10, cloud-start 7),
  including the 65 s Settings-first join with one resume and no create, a newer turn after Stop
  sharing the same wake, and a joined turn failing fast on an error state with one resume.
  `tsc -p tsconfig.server.json` exit 0; no comments in the changed files.

## Review findings

- Clover (Claude) on `830641cb`: a turn that joined a 60 s Settings wake died at about 60 s.
  Repaired in `e0c42dd`; Clover's re-run of that probe at `11f2f15` passed (65,114 ms, one resume,
  no create) after correcting the probe's own cleanup to wait for the turn to settle.
- Independent native Codex review `task_e_6af26f117a208329b564b29c6f3a4d10` at `11f2f15`:
  changes requested, despite 92 focused tests and typecheck passing. The Settings join added a
  wanter that stayed true until the shared wake settled, not for the request's lifetime. After the
  Settings client disconnected, a Stop or newer turn removed the real turn wanter, but the abandoned
  Settings wanter kept the wake polling until ready or the deadline (up to 330 s).
- Repair `1ff6a0e2` (authored by Clover on Claude Opus 5.5; the saved Codex selection was
  unchanged but not the engine used): `joinBotBoatWake` takes a `connected` predicate, and the
  Settings route passes `() => !res.destroyed`. No new state, listener, manager or dependency. The
  330 s and 45 s budgets, the wait-only join, and the absence of extra resume, create or retry are
  unchanged.
- Why `res.destroyed` and not request close: on Node v24.22.0, an isolated server showed that
  `req` emits `close` and sets `req.destroyed` as soon as a healthy POST body has been read, while
  `res.destroyed` and the socket stay open until the response ends. Only a real client abort
  flips `res.destroyed`. This route never reads its body, so on this route `req.destroyed` would
  also have passed both new cases (a mutation run with `!req.destroyed` passed the connected
  case); `res.destroyed` stays correct if the route ever reads a body.

Disconnected Settings repair, at `1ff6a0e2`, on Clover's cloud computer (Node v24.22.0, pnpm 10.33.0):

- Before, `11f2f15` with the two new e2e cases: 1 failed, 1 passed. After the Settings client
  aborted and the turn was stopped, the wake kept reading the computer (8 then 11 reads in 6 s).
  The connected countercase passed.
- After: both pass. The abandoned case stops polling within one poll interval after Stop, does not
  resume the computer again when it is put back to sleep, and makes no create. The connected case,
  with a JSON body that the client finished sending, still reports `ready: true` after Stop with one
  resume.
- Focused run at `1ff6a0e2` (01:35:15 UTC, 337 s): 11 files, 82 tests passed (`cloud-start`,
  `cloud-computer-slow-start.e2e` including both new cases, `boat-wait-ready`, `boat-turn`,
  `boat-lifecycle`, `boat-provision`, `computers`, `boat-included.e2e`, `place-view.e2e`,
  `surface-pins.e2e`, `scripts/no-comments`). `tsc --noEmit -p tsconfig.server.json` exit 0;
  `oxlint` on the two changed source files: 0 warnings, 0 errors. The native review's 92-test run at
  `11f2f15` is separate evidence and was not repeated here.

## Limits

- The fixtures use the included boat relay path; the later.dog computers path shares the same
  caller and has the same guard in `waitRunning`, covered by its unit suite, not end to end.
- A connected Settings request that joins a turn's wake can wait up to that turn's remaining budget.
- Through the production proxy, a browser disconnect is assumed to close the upstream connection
  to the home; this was not tested end to end.
- No cross-backend review of `1ff6a0e2` yet; the author engine was Claude.
- First-time provisioning still waits 90 s.
- No live computer, home, provider or full server suite was used. Not deployed.
